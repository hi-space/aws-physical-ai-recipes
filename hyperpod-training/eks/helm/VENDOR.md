# HyperPodHelmChart (vendored)

Upstream: https://github.com/aws/sagemaker-hyperpod-cli/tree/main/helm_chart/HyperPodHelmChart
Commit: 2fef76865f50df9a522c73bd918cb1207eb7ccec

The chart is copied here with its remote dependencies already fetched (`charts/*.tgz`) so the
CDK kubectl handler can install it as a local asset without network access to Helm repositories.

Refresh:

```bash
git clone --depth 1 https://github.com/aws/sagemaker-hyperpod-cli.git /tmp/sagemaker-hyperpod-cli
helm dependency update /tmp/sagemaker-hyperpod-cli/helm_chart/HyperPodHelmChart
rm -rf hyperpod-training/eks/helm/HyperPodHelmChart
cp -r /tmp/sagemaker-hyperpod-cli/helm_chart/HyperPodHelmChart hyperpod-training/eks/helm/
```
