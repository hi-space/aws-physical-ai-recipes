# Release 3 원본 통합과 배포 검증

확인 시각: **2026-09-16 17:07 UTC**. 계정 `913524902871`, 리전 `us-east-1`.

접속: `https://physical-ai.hi-yoo.com/`

## 소스와 실행 중 이미지

원본 저장소의 `feat/hyperpod-dashboard`에 구현을 통합했다. 배포 소스는 커밋 **`0390e2bcd19ce7a134eb77867af91f0f5bd245ef`**다. Next.js는 **16.3.5**로 고정되어 있다.

실행 중인 web, controller, gateway 컨테이너 3개 모두 다음 digest를 확인했다:

```text
sha256:e9f1df13657f97c6162b268c212db2ff4a5fee2ffb229be0d35e52fd6efc3025
```

| 항목 | 확인 결과 |
|---|---|
| CloudFormation | `PhysicalAiDashboard-913524902871`, `UPDATE_COMPLETE` |
| Web | `PhysicalAiDashboardWebTaskDefD0130F4C:18`, running 1 / pending 0 |
| Controller | `PhysicalAiDashboardWebControllerTaskE9024EAA:8`, running 1 / pending 0 |
| Gateway | `PhysicalAiDashboardWebGatewayTask10DBE637:8`, running 1 / pending 0 |
| 업데이트 범위 | ECS TaskDefinition 3개. 리소스 추가·삭제 없음 |
| 학습 이미지 | 검증된 MuJoCo, Isaac Lab, GR00T, OpenPI, ROS 2, workspace, runtime asset hash 유지 |

통합 시 원본의 파일 모드와 생성된 Python `egg-info`가 컨테이너 asset hash에 영향을 주는 문제가 있었다. CDK가 만드는 격리된 복사본에서만 파일 모드와 생성물 제외 규칙을 정규화했다. 원본 워크숍 파일과 모드는 바꾸지 않았다.

## 검증

- 통합 소스: 웹 테스트 **843 통과 / 기존 opt-in 1 건 skip**, 웹·E2E TypeScript 검사, Next 빌드, service bundle, CDK TypeScript·오케스트레이션 테스트 통과.
- 배포 후 브라우저: **3 통과** — Cognito 로그인과 전체 화면 탐색, `/api/me`, 프로젝트 API 토큰의 권한 상한·즉시 폐기.
- 배포 후 DCV: **1 통과** — HTTPS 200, 실제 콘솔 연결 증가, 화면 canvas 확인, 테스트 접속 종료.
- 실제 학습·체크포인트 복구·분산 실행·Isaac GPU 영상·ROS 2·데이터 게시 검증은 [이전 실행 증거](2026-09-16-release3-validation.md)에 고정된 실행 ID와 함께 보존했다.

[배포 로그](evidence/2026-09-16-release3-integration/deploy.log), [브라우저 로그](evidence/2026-09-16-release3-integration/smoke.log), [DCV 로그](evidence/2026-09-16-release3-integration/dcv.log), [실행 자원 감사](evidence/2026-09-16-release3-integration/resource-audit.json), [원본 보존 감사](evidence/2026-09-16-release3-integration/original-preservation.json).

## 보존과 정리

원래 수정되어 있던 워크숍 파일 4개와 미추적 `Dockerfile.bak`의 SHA-256이 통합 전과 모두 같다. 충돌 없는 원본의 인증 복구·호환 코드와 기존 Git 이력도 유지했다.

감사 시 활성 대시보드 워크플로·Pod·DCV SSM 터널은 0개였다. 임시 Fargate 진단 작업은 종료했고 SageMaker 테스트 실행 3개는 모두 terminal 상태였다. 기존 CPU 노드 2대와 GPU 노드 1대는 Ready이며 외부 작업자가 설정한 GPU 기준 1대를 유지했다. 알림 구독은 0개다. 증거 데이터셋·모델·평가·S3 버전은 보존했다.

## 남은 범위

**배포된 핵심 경로의 검증 통과가 전체 OSMO 기능 완성을 의미하지 않는다.** 대용량 runtime checkpoint, 전체 이력 계보 보호, 로그 replay, 사용량·안전한 축소, 추가 빌드·모델 연계 등 소프트웨어 과제는 [대응표](2026-09-16-feature-evidence.md)를 따라 계속 보완한다. 실제 GR00T 학습 성공, 다른 모델·장면과 물리 로봇 검증은 아직 통과로 표시하지 않는다. MuJoCo 평가 2회 결과는 `REVIEW`, `approved=false`다.
