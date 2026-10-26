# scripts/eks: EKS 쪽 설치 스크립트

> English: [README.md](README.md)

여기 있는 것은 모두 **CDK 밖에서** 만든다. `cdk destroy` 로는 지워지지 않으므로 설치 스크립트마다
짝이 되는 `delete-*.sh` 가 있고, 그중 몇 개(ALB, WAF, CloudFront, AMP, EBS)는 상시 과금된다.

이 디렉터리가 아니라 `hyperpod-training/` 에서 실행한다.

```bash
./scripts/eks/kubeconfig.sh
```

## 관측 경로는 둘 중 하나

둘은 선택지이고, 겹쳐 쓰는 계층이 아니다.

```
install-observability.sh      AMP + amazon-sagemaker-hyperpod-observability 애드온 + Grafana.
                              애드온은 리전마다 제공 여부가 다르다(ap-northeast-2 에 없음).

install-dashboard-public.sh   kube-prometheus-stack + DCGM exporter + Grafana 를 전부 클러스터
                              안에 올리고 CloudFront 주소 하나로 공개한다. 애드온이 없는 리전용
                              경로이고, 서울에서 하는 워크숍이 쓰는 쪽이다.
```

애드온을 CDK 스택에서 일부러 떼어 놓았다. 미지원 리전에서 `CreateAddon` 이 400 을 내면
CloudFormation 이 스택 전체를 롤백해 VPC·FSx·HyperPod 클러스터까지 함께 되돌린다.

## 클러스터 내부 경로의 설치 순서

순서가 중요하다. 각 스크립트가 선행 조건을 확인하고, 무엇을 먼저 돌려야 하는지 알려주며 멈춘다.

```bash
./scripts/eks/install-dashboard-public.sh      # 약 25분  ALB + WAF + CloudFront + Grafana + Prometheus + DCGM
./scripts/eks/install-mlflow-selfhosted.sh     # 약 10분  MLflow + Postgres + TensorBoard, 같은 ALB
./scripts/eks/install-unified-dashboard.sh     # 약 3분   전부 앞에 두는 진입 화면 하나
./scripts/eks/install-dashboard-hardening.sh   # 약 10분  (선택) 지표 보존 + 알림 발송
./scripts/eks/install-job-portal.sh            # 약 8분   (선택) 브라우저에서 Job 제출
./scripts/eks/install-logs.sh                  # 약 8분   (선택) 끝난 Job 의 로그를 S3 에 보관
```

이 순서인 이유.

- `install-dashboard-public.sh` 는 Prometheus·Grafana 를 `emptyDir` 에 retention 6h 로 올린다.
  그 시점에 gp3 StorageClass 가 아직 없기 때문이다.
- `install-mlflow-selfhosted.sh` 가 EBS CSI 애드온과 gp3 StorageClass 를 만든다. PVC 를 쓰는
  이후 스크립트는 모두 이것이 먼저 돌았다는 데 의존한다.
- `install-dashboard-hardening.sh` 가 그다음에 Prometheus·Grafana 를 gp3 PVC 로 옮긴다. 둘 다
  끝난 뒤여야 한다 — Grafana 는 알림 상태를 자기 DB 에 쓰므로 `emptyDir` 이면 잃는다.

삭제는 역순으로 한다.

```bash
./scripts/eks/delete-logs.sh
./scripts/eks/delete-job-portal.sh
./scripts/eks/delete-dashboard-hardening.sh
./scripts/eks/delete-unified-dashboard.sh
./scripts/eks/delete-mlflow-selfhosted.sh
./scripts/eks/delete-dashboard-public.sh       # IngressGroup 에 Ingress 가 남아 있으면 ALB 는 유지된다
```

## ALB 하나, CloudFront 하나, UI 네 개

모든 Ingress 가 `hyperpod-dashboard` IngressGroup 에 들어가므로, 스크립트들이 로드밸런서와
배포를 하나씩 따로 만들지 않고 공유한다.

```
https://<cloudfront-도메인>/             Grafana      클러스터 상태, 그리고 홈 대시보드
                   /mlflow               MLflow       학습 지표와 Model Registry
                   /tensorboard          TensorBoard  MLflow 에 없는 run 을 위한 대안
                   /argo                 Argo         Job 제출과 관찰
```

## 파일

| 파일 | 역할 |
|---|---|
| `kubeconfig.sh` | `kubectl` 컨텍스트를 `hyperpod-eks-<account>` 로 맞추고 노드·애드온을 확인한다. 가장 먼저 돌린다 |
| `install-observability.sh` · `delete-observability.sh` | AMP 워크스페이스 + 관측 애드온 + Grafana. 기본은 클러스터 안 Helm, `--grafana amg` 면 Amazon Managed Grafana. AMP 워크스페이스는 비어 있어도 과금되므로 `cdk destroy` 전에 지운다 |
| `grafana-user.sh` | Managed Grafana 워크스페이스에 IAM Identity Center 사용자를 ADMIN 으로 할당한다. `--grafana amg` 경로에서만 필요하고, 그 워크스페이스는 사용자가 아예 없는 상태로 생성된다 (`--role ADMIN\|EDITOR\|VIEWER`) |
| `install-dashboard-public.sh` · `delete-dashboard-public.sh` | 클러스터 내부 대시보드 스택: kube-prometheus-stack, DCGM exporter, Grafana, ALB, WAF(us-east-1 / CLOUDFRONT scope), CloudFront. ALB inbound 80 은 CloudFront origin-facing prefix list 로만 열고 TLS 는 CloudFront 에서 끊는다. 삭제는 15~25분이고 대부분이 CloudFront 전파 대기다 |
| `install-mlflow-selfhosted.sh` · `delete-mlflow-selfhosted.sh` | MLflow 3.16(백엔드 Postgres 17 on gp3, artifact 는 스택의 S3 버킷, basic auth) + `/fsx/checkpoints` 를 읽기 전용으로 보는 TensorBoard. EBS CSI 애드온과 이후 스크립트가 쓰는 gp3 StorageClass 도 여기서 만든다. 삭제는 기본으로 데이터를 남긴다 (`--purge-db`, `--purge-artifacts`, `--purge-all`, `--remove-ebs-csi`) |
| `install-unified-dashboard.sh` · `delete-unified-dashboard.sh` | Training Console 을 Grafana 홈 대시보드로 지정하고 MLflow Postgres 를 읽기 전용 데이터소스로 더해, MLflow run 수와 학습 loss 를 Grafana 안에서 그린다 |
| `install-dashboard-hardening.sh` · `delete-dashboard-hardening.sh` | Prometheus 를 50Gi gp3 PVC + retention 15d 로, Grafana 를 자기 PVC 로 옮기고, SNS 토픽·pod identity·알림 규칙 4개를 프로비저닝한다. Grafana 가 `Recreate` 전략으로 재시작하므로 잠깐 끊긴다 |
| `install-job-portal.sh` · `delete-job-portal.sh` | Argo Workflows + WorkflowTemplate 9개를 `/argo` 에 올린다. submit 단계가 CLI 경로와 같은 `k8s-templates/render.sh` 를 호출하므로 Job 정의가 한 벌이다. `vla-eval-gate` 는 eval → gate 를 엮고 BLOCK 이면 워크플로가 실패한다. 삭제 중에 돌던 Workflow 는 끊긴다 (`--purge-jobs`, `--remove-crds`) |
| `install-logs.sh` · `delete-logs.sh` | Loki(SingleBinary, chunk 는 `s3://<데이터 버킷>/loki/`) + Grafana Alloy DaemonSet + `Loki` 데이터소스. 파드가 회수된 뒤에도 끝난 Job 의 로그가 남는다. S3 내용은 `--purge-s3` 가 없으면 지우지 않는다 |
| `create-governance.sh` · `delete-governance.sh` | cluster policy(우선순위 클래스 training/inference/background, FairShare) + 팀별 compute quota. CloudFormation 리소스 타입이 없어 CLI 로 만든다. **남겨 두면 HyperPod 클러스터 삭제가 막히므로** `cdk destroy` 전에 삭제 스크립트를 돌린다 |
| `dcv-target.sh` | GPU 노드의 SSM target 과 DCV 포트 포워딩 명령을 출력한다. HyperPod 의 SSM target 형식은 `sagemaker-cluster:<cluster-id>_<instance-group>-<ec2-id>` (`--group`, `--local-port`) |

모든 스크립트가 `--cluster` 를 받고 기본값은 `hyperpod-eks-<account-id>` 다.

리전 처리는 균일하지 않다. `kubeconfig.sh`, `install-observability.sh`,
`delete-observability.sh`, `grafana-user.sh`, `create-governance.sh`, `delete-governance.sh` 는
`--region` 을 받고 없으면 환경에서 찾는다. `dcv-target.sh` 는 플래그 없이 환경에서만 찾는다.
나머지 열두 개는 스크립트 안에 `REGION="ap-northeast-2"` 로 고정돼 있어 다른 리전에서 쓰려면
고쳐야 한다.

`install-*` 과 `delete-*` 은 변경 전에 확인 프롬프트를 띄우고 `--yes`(또는 `-y`)로 건너뛸 수
있다. `install-observability.sh` 와 `delete-governance.sh` 두 개만 예외로 아예 묻지 않는다.

## 비용

클러스터 내부 경로는 워크숍이 끝난 뒤에도 과금되는 리소스를 남긴다. ALB·WAF·CloudFront 는 아무도
대시보드를 열지 않아도 과금되고, AMP 워크스페이스는 지표가 없어도 과금된다. `cdk destroy` 에
기대지 말고 짝이 되는 `delete-*.sh` 를 돌린다.
