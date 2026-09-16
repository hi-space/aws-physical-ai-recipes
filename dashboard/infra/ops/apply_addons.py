#!/usr/bin/env python3
"""Install dashboard-owned RBAC/policies and a checksum-pinned JobSet release."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
from urllib.request import Request, urlopen

MANAGED = {"app.kubernetes.io/managed-by": "physical-ai-dashboard"}
JOBSET_VERSION = "v0.12.0"
JOBSET_SHA256 = "a41aaf12dd0b7b0a3d626b8d6107f32c3dc889d7e7830adc46b8cdb77a8963bb"


def resources(namespaces):
    result = [{
        "apiVersion": "rbac.authorization.k8s.io/v1", "kind": "ClusterRole",
        "metadata": {"name": "physical-ai-discovery", "labels": MANAGED},
        "rules": [
            {"apiGroups": [""], "resources": ["nodes", "namespaces", "persistentvolumes"], "verbs": ["get", "list", "watch"]},
            {"apiGroups": [""], "resources": ["pods", "events"], "verbs": ["get", "list", "watch"]},
            {"apiGroups": ["batch"], "resources": ["jobs"], "verbs": ["get", "list", "watch"]},
            {"apiGroups": ["storage.k8s.io"], "resources": ["storageclasses"], "verbs": ["get", "list", "watch"]},
            {"apiGroups": ["kueue.x-k8s.io"], "resources": ["clusterqueues", "localqueues", "resourceflavors", "workloads", "workloadpriorityclasses", "topologies"], "verbs": ["get", "list", "watch"]},
        ],
    }, {
        "apiVersion": "rbac.authorization.k8s.io/v1", "kind": "ClusterRoleBinding",
        "metadata": {"name": "physical-ai-discovery", "labels": MANAGED},
        "roleRef": {"apiGroup": "rbac.authorization.k8s.io", "kind": "ClusterRole", "name": "physical-ai-discovery"},
        "subjects": [{"kind": "Group", "apiGroup": "rbac.authorization.k8s.io", "name": f"physical-ai:{role}"} for role in ["web", "controller", "gateway"]],
    }]
    for namespace in namespaces:
        meta = {"namespace": namespace, "labels": MANAGED}
        verbs = ["get", "list", "watch", "create", "update", "patch", "delete", "deletecollection"]
        result.extend([{
            "apiVersion": "v1", "kind": "ServiceAccount",
            "metadata": {**meta, "name": "pai-workload"}, "automountServiceAccountToken": False,
        }, {
            "apiVersion": "rbac.authorization.k8s.io/v1", "kind": "Role",
            "metadata": {**meta, "name": "physical-ai-workloads"},
            "rules": [
                {"apiGroups": [""], "resources": ["pods", "pods/log", "configmaps", "secrets", "services", "endpoints", "persistentvolumeclaims", "events"], "verbs": verbs},
                {"apiGroups": [""], "resources": ["serviceaccounts"], "verbs": ["get"]},
                {"apiGroups": ["batch"], "resources": ["jobs"], "verbs": verbs},
                {"apiGroups": ["apps"], "resources": ["deployments"], "verbs": verbs},
                {"apiGroups": ["jobset.x-k8s.io"], "resources": ["jobsets"], "verbs": verbs},
                {"apiGroups": ["kubeflow.org"], "resources": ["pytorchjobs", "mpijobs"], "verbs": verbs},
                {"apiGroups": ["networking.k8s.io"], "resources": ["networkpolicies"], "verbs": verbs},
            ],
        }, {
            "apiVersion": "rbac.authorization.k8s.io/v1", "kind": "RoleBinding",
            "metadata": {**meta, "name": "physical-ai-workloads"},
            "roleRef": {"apiGroup": "rbac.authorization.k8s.io", "kind": "Role", "name": "physical-ai-workloads"},
            "subjects": [{"kind": "Group", "apiGroup": "rbac.authorization.k8s.io", "name": f"physical-ai:{role}"} for role in ["web", "controller"]],
        }, {
            "apiVersion": "rbac.authorization.k8s.io/v1", "kind": "Role",
            "metadata": {**meta, "name": "physical-ai-gateway"},
            "rules": [
                {"apiGroups": [""], "resources": ["pods", "pods/log", "services", "endpoints"], "verbs": ["get", "list", "watch"]},
                {"apiGroups": [""], "resources": ["pods/exec", "pods/portforward"], "verbs": ["get", "create"]},
            ],
        }, {
            "apiVersion": "rbac.authorization.k8s.io/v1", "kind": "RoleBinding",
            "metadata": {**meta, "name": "physical-ai-gateway"},
            "roleRef": {"apiGroup": "rbac.authorization.k8s.io", "kind": "Role", "name": "physical-ai-gateway"},
            "subjects": [{"kind": "Group", "apiGroup": "rbac.authorization.k8s.io", "name": "physical-ai:gateway"}],
        }, {
            "apiVersion": "networking.k8s.io/v1", "kind": "NetworkPolicy",
            "metadata": {**meta, "name": "physical-ai-workloads"},
            "spec": {
                "podSelector": {"matchLabels": MANAGED, "matchExpressions": [{"key": "pai.aws/session", "operator": "DoesNotExist"}, {"key": "pai.aws/project", "operator": "Exists"}]},
                "policyTypes": ["Ingress", "Egress"],
                "ingress": [{"from": [{"podSelector": {}}, {"namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": "hyperpod-observability"}}}]}],
                "egress": [{"to": [{"ipBlock": {"cidr": "0.0.0.0/0", "except": ["169.254.169.254/32", "169.254.170.23/32"]}}]}],
            },
        }, {
            "apiVersion": "networking.k8s.io/v1", "kind": "NetworkPolicy",
            "metadata": {**meta, "name": "physical-ai-sessions"},
            "spec": {
                "podSelector": {"matchLabels": MANAGED, "matchExpressions": [{"key": "pai.aws/session", "operator": "Exists"}, {"key": "pai.aws/project", "operator": "Exists"}]},
                "policyTypes": ["Ingress", "Egress"], "ingress": [],
                "egress": [{"to": [{"ipBlock": {"cidr": "0.0.0.0/0", "except": ["169.254.169.254/32", "169.254.170.23/32"]}}]}],
            },
        }])
    result.extend([{
        "apiVersion": "rbac.authorization.k8s.io/v1", "kind": "Role",
        "metadata": {"name": "physical-ai-grafana", "namespace": "grafana", "labels": MANAGED},
        "rules": [
            {"apiGroups": [""], "resources": ["secrets"], "resourceNames": ["grafana"], "verbs": ["get"]},
            {"apiGroups": [""], "resources": ["services/proxy"], "verbs": ["get", "create"]},
        ],
    }, {
        "apiVersion": "rbac.authorization.k8s.io/v1", "kind": "RoleBinding",
        "metadata": {"name": "physical-ai-grafana", "namespace": "grafana", "labels": MANAGED},
        "roleRef": {"apiGroup": "rbac.authorization.k8s.io", "kind": "Role", "name": "physical-ai-grafana"},
        "subjects": [{"kind": "Group", "apiGroup": "rbac.authorization.k8s.io", "name": "physical-ai:web"}],
    }])
    return {"apiVersion": "v1", "kind": "List", "items": result}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--cluster", default=os.environ.get("EKS_CLUSTER_NAME"))
    parser.add_argument("--region", default=os.environ.get("AWS_REGION", "us-east-1"))
    parser.add_argument("--kubeconfig", default="/tmp/physical-ai-addons.kubeconfig")
    parser.add_argument("--render-only", action="store_true")
    args = parser.parse_args()
    if args.render_only:
        print(json.dumps(resources(["hyperpod-ns-team-a", "hyperpod-ns-team-b", "rl"]), indent=2))
        return
    if not args.cluster:
        parser.error("--cluster is required")
    subprocess.run(["aws", "eks", "update-kubeconfig", "--region", args.region, "--name", args.cluster, "--kubeconfig", args.kubeconfig], check=True)
    kubectl = ["kubectl", "--kubeconfig", args.kubeconfig]

    def read(*command):
        return json.loads(subprocess.check_output(kubectl + list(command) + ["-o", "json"]))

    # Keep every existing CNI setting and argument except the documented switch.
    configmap = read("-n", "kube-system", "get", "configmap", "amazon-vpc-cni")
    if configmap.get("data", {}).get("enable-network-policy-controller") != "true":
        subprocess.run(kubectl + ["-n", "kube-system", "patch", "configmap", "amazon-vpc-cni", "--type=merge", "-p", json.dumps({"data": {"enable-network-policy-controller": "true"}})], check=True)
    daemonset = read("-n", "kube-system", "get", "daemonset", "aws-node")
    agent = next((container for container in daemonset["spec"]["template"]["spec"]["containers"] if any("--enable-network-policy=" in arg for arg in container.get("args", []))), None)
    if not agent:
        raise RuntimeError("The installed CNI has no network policy agent; update the supported CNI installation first")
    new_args = ["--enable-network-policy=true" if arg.startswith("--enable-network-policy=") else arg for arg in agent["args"]]
    if new_args != agent["args"]:
        patch = {"spec": {"template": {"spec": {"containers": [{"name": agent["name"], "args": new_args}]}}}}
        subprocess.run(kubectl + ["-n", "kube-system", "patch", "daemonset", "aws-node", "--type=strategic", "-p", json.dumps(patch)], check=True)
        subprocess.run(kubectl + ["-n", "kube-system", "rollout", "status", "daemonset/aws-node", "--timeout=300s"], check=True)

    existing_crd = subprocess.run(kubectl + ["get", "crd", "jobsets.jobset.x-k8s.io"], capture_output=True)
    if existing_crd.returncode:
        url = f"https://github.com/kubernetes-sigs/jobset/releases/download/{JOBSET_VERSION}/manifests.yaml"
        raw = urlopen(Request(url, headers={"User-Agent": "physical-ai-dashboard"}), timeout=60).read()
        if hashlib.sha256(raw).hexdigest() != JOBSET_SHA256:
            raise RuntimeError("JobSet release checksum mismatch")
        with tempfile.TemporaryDirectory(prefix="pai-jobset-") as directory:
            manifest = Path(directory) / "jobset.yaml"
            manifest.write_bytes(raw)
            subprocess.run(kubectl + ["apply", "--server-side", "--field-manager=physical-ai-dashboard", "-f", str(manifest)], check=True)
    subprocess.run(kubectl + ["-n", "jobset-system", "rollout", "status", "deployment/jobset-controller-manager", "--timeout=300s"], check=True)
    namespaces = [item["metadata"]["name"] for item in read("get", "namespaces")["items"] if item["metadata"]["name"].startswith("hyperpod-ns-") or item["metadata"]["name"] == "rl"]
    subprocess.run(kubectl + ["apply", "-f", "-"], input=json.dumps(resources(namespaces)), text=True, check=True)
    print(json.dumps({"ready": True, "namespaces": namespaces, "jobsetRelease": JOBSET_VERSION}))


if __name__ == "__main__":
    main()
