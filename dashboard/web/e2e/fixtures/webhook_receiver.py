"""Owned, temporary AWS receiver for the live webhook acceptance test.

No credential/signature values are printed. The private manifest is consumed by
the Playwright test and by cleanup. This never subscribes a person or third party.
"""
import io
import json
import os
from pathlib import Path
import secrets
import sys
import time
import zipfile

import boto3
from botocore.exceptions import ClientError

HANDLER = r'''
import base64, hashlib, hmac, json, os, time
def handler(event, context):
    if event.get("requestContext", {}).get("http", {}).get("method") != "POST":
        return {"statusCode": 405, "body": ""}
    headers = {k.lower(): v for k, v in event.get("headers", {}).items()}
    raw = event.get("body", "")
    try:
        body = base64.b64decode(raw) if event.get("isBase64Encoded") else raw.encode()
        timestamp = headers.get("x-pai-timestamp", "")
        event_id = headers.get("x-pai-event-id", "")
        if len(body) > 16384 or abs(time.time() - int(timestamp)) > 300:
            raise ValueError("bounds")
        expected = "v1=" + hmac.new(os.environ["SIGNING_KEY"].encode(),
            timestamp.encode() + b"." + event_id.encode() + b"." + body, hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, headers.get("x-pai-signature", "")):
            raise ValueError("signature")
        payload = json.loads(body)
        if payload.get("projectId") != os.environ["PROJECT_ID"] or not event_id:
            raise ValueError("identity")
    except Exception:
        return {"statusCode": 403, "body": ""}
    print(json.dumps({"kind": "pai-webhook-receipt", "eventId": event_id,
        "deliveryId": headers.get("x-pai-delivery-id"), "runId": payload["runId"],
        "projectId": payload["projectId"], "status": payload["status"],
        "signatureVerified": True, "bodySHA256": hashlib.sha256(body).hexdigest()}))
    return {"statusCode": 200, "body": '{"accepted":true}'}
'''


def save(path, state):
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w") as stream:
        json.dump(state, stream)


def setup(path):
    if path.exists():
        raise RuntimeError("Refusing to replace an existing receiver manifest")
    region = "us-east-1"
    session = boto3.Session(region_name=region)
    iam, lam, logs = session.client("iam"), session.client("lambda"), session.client("logs")
    account = session.client("sts").get_caller_identity()["Account"]
    identifier = secrets.token_hex(6)
    name = "pai-webhook-e2e-" + identifier
    state = {"region": region, "account": account, "testId": identifier, "name": name,
             "projectId": "workshop", "logGroup": "/aws/lambda/" + name, "secret": secrets.token_hex(32),
             "roleCreated": False, "functionCreated": False, "logsCreated": False}
    save(path, state)
    role = iam.create_role(RoleName=name,
        AssumeRolePolicyDocument=json.dumps({"Version": "2012-10-17", "Statement": [{
            "Effect": "Allow", "Principal": {"Service": "lambda.amazonaws.com"}, "Action": "sts:AssumeRole"}]}),
        Tags=[{"Key": "pai:test-id", "Value": identifier}])
    state["roleArn"], state["roleCreated"] = role["Role"]["Arn"], True
    save(path, state)
    logs.create_log_group(logGroupName=state["logGroup"], tags={"pai:test-id": identifier})
    state["logsCreated"] = True
    save(path, state)
    logs.put_retention_policy(logGroupName=state["logGroup"], retentionInDays=1)
    iam.put_role_policy(RoleName=name, PolicyName="OwnReceiptLogs", PolicyDocument=json.dumps({
        "Version": "2012-10-17", "Statement": [{"Effect": "Allow",
            "Action": ["logs:CreateLogStream", "logs:PutLogEvents"],
            "Resource": f"arn:aws:logs:{region}:{account}:log-group:{state['logGroup']}:*"}]}))
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as package:
        package.writestr("receiver.py", HANDLER)
    for attempt in range(12):
        try:
            result = lam.create_function(FunctionName=name, Runtime="python3.13", Role=state["roleArn"],
                Handler="receiver.handler", Code={"ZipFile": archive.getvalue()}, Timeout=3, MemorySize=128,
                Environment={"Variables": {"SIGNING_KEY": state["secret"], "PROJECT_ID": state["projectId"]}},
                Tags={"pai:test-id": identifier}, Architectures=["arm64"])
            break
        except ClientError as error:
            if error.response["Error"]["Code"] != "InvalidParameterValueException" or attempt == 11:
                raise
            time.sleep(3)
    state["functionArn"], state["functionCreated"] = result["FunctionArn"], True
    save(path, state)
    lam.get_waiter("function_active_v2").wait(FunctionName=name, WaiterConfig={"Delay": 2, "MaxAttempts": 30})
    lam.put_function_concurrency(FunctionName=name, ReservedConcurrentExecutions=1)
    result = lam.create_function_url_config(FunctionName=name, AuthType="NONE", InvokeMode="BUFFERED")
    state["url"] = result["FunctionUrl"]
    save(path, state)
    lam.add_permission(FunctionName=name, StatementId="SignedPublicUrl", Action="lambda:InvokeFunctionUrl",
                       Principal="*", FunctionUrlAuthType="NONE")
    lam.add_permission(FunctionName=name, StatementId="ViaUrlOnly", Action="lambda:InvokeFunction",
                       Principal="*", InvokedViaFunctionUrl=True)
    print(json.dumps({"ready": True, "name": name, "region": region}))


def cleanup(path):
    state = json.loads(path.read_text())
    session = boto3.Session(region_name=state["region"])
    iam, lam, logs = session.client("iam"), session.client("lambda"), session.client("logs")
    if state["functionCreated"]:
        try:
            tags = lam.list_tags(Resource=state["functionArn"])["Tags"]
            if tags.get("pai:test-id") != state["testId"]:
                raise RuntimeError("Receiver ownership mismatch")
            try:
                lam.delete_function_url_config(FunctionName=state["name"])
            except lam.exceptions.ResourceNotFoundException:
                pass
            lam.delete_function(FunctionName=state["name"])
        except lam.exceptions.ResourceNotFoundException:
            pass
    if state["logsCreated"]:
        try:
            tags = logs.list_tags_log_group(logGroupName=state["logGroup"])["tags"]
            if tags.get("pai:test-id") != state["testId"]:
                raise RuntimeError("Receipt log ownership mismatch")
            logs.delete_log_group(logGroupName=state["logGroup"])
        except logs.exceptions.ResourceNotFoundException:
            pass
    if state["roleCreated"]:
        try:
            tags = iam.list_role_tags(RoleName=state["name"])["Tags"]
            if not any(tag["Key"] == "pai:test-id" and tag["Value"] == state["testId"] for tag in tags):
                raise RuntimeError("Receiver role ownership mismatch")
            try:
                iam.delete_role_policy(RoleName=state["name"], PolicyName="OwnReceiptLogs")
            except iam.exceptions.NoSuchEntityException:
                pass
            iam.delete_role(RoleName=state["name"])
        except iam.exceptions.NoSuchEntityException:
            pass
    state.pop("secret", None)
    state["cleaned"] = True
    save(path, state)
    print(json.dumps({"cleaned": True, "name": state["name"]}))


if __name__ == "__main__":
    command, manifest = sys.argv[1:3]
    if command not in ("setup", "cleanup"):
        raise SystemExit("Use setup or cleanup")
    try:
        (setup if command == "setup" else cleanup)(Path(manifest))
    except Exception as error:
        # AWS exception payloads or environment values must never reach test logs.
        print(json.dumps({"ok": False, "operation": command, "errorType": type(error).__name__}))
        raise SystemExit(1)
