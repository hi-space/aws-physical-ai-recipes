#!/bin/bash
set -euo pipefail

echo "=== SageMaker MLflow Setup ==="

pip install mlflow sagemaker-mlflow boto3

TRACKING_URI="${MLFLOW_TRACKING_URI:-}"
if [ -z "$TRACKING_URI" ]; then
  echo ""
  echo "MLFLOW_TRACKING_URI가 설정되지 않았습니다."
  echo "CDK 배포 후 출력된 MlflowTrackingUri 값을 사용하세요:"
  echo ""
  echo "  export MLFLOW_TRACKING_URI=<CDK output의 MlflowTrackingUri>"
  echo ""
  echo "또는 ~/.bashrc에 추가:"
  echo "  echo 'export MLFLOW_TRACKING_URI=...' >> ~/.bashrc"
  exit 1
fi

echo "Testing connection to: ${TRACKING_URI}"
python -c "
import mlflow
mlflow.set_tracking_uri('${TRACKING_URI}')
client = mlflow.MlflowClient()
experiments = client.search_experiments()
print(f'Connected! Found {len(experiments)} experiments.')
"

echo ""
echo "=== Setup Complete ==="
echo "MLflow UI: SageMaker Studio > MLflow 에서 확인"
