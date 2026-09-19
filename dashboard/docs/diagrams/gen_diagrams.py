#!/usr/bin/env python3
"""Generate the Physical AI Dashboard feature/AWS-mapping diagrams as a multi-page draw.io file.

Usage:
    python3 gen_diagrams.py            # writes physical-ai-dashboard-features.drawio
    ./export.sh                        # exports every page to PNG (needs draw.io desktop CLI)

Every icon uses the official AWS Architecture Icons bundled with draw.io (mxgraph.aws4).
Icon names below were verified to render in draw.io desktop (see docs/diagrams/README.md).
"""
from __future__ import annotations

import html
from dataclasses import dataclass, field

# ---------------------------------------------------------------------------
# AWS icon catalogue (verified with a rendered test sheet on 2026-09-18)
# ---------------------------------------------------------------------------
ICON_COLORS = {
    # compute / containers (orange)
    "ecs": "#ED7100", "fargate": "#ED7100", "ec2": "#ED7100", "eks": "#ED7100", "lambda": "#ED7100",
    "ecr": "#ED7100", "ecs_service": "#ED7100", "ecs_task": "#ED7100", "container_2": "#ED7100",
    "container_registry_image": "#ED7100",
    # storage (green)
    "s3": "#7AA116", "fsx_for_lustre": "#7AA116",
    # database (purple)
    "dynamodb": "#C925D1",
    # app integration (pink)
    "sns": "#E7157B",
    # networking (purple)
    "route_53": "#8C4FFF", "cloud_map": "#8C4FFF", "internet": "#8C4FFF",
    # security (red)
    "cognito": "#DD344C", "identity_and_access_management": "#DD344C", "secrets_manager": "#DD344C",
    "certificate_manager": "#DD344C", "key_management_service": "#DD344C",
    # management (pink)
    "cloudwatch": "#E7157B", "cloudwatch_logs": "#E7157B", "systems_manager": "#E7157B",
    "parameter_store": "#E7157B", "managed_service_for_prometheus": "#E7157B",
    # ML (teal)
    "sagemaker": "#01A88D", "sagemaker_model": "#01A88D", "sagemaker_train": "#01A88D",
    "sagemaker_notebook": "#01A88D", "deep_learning_containers": "#01A88D",
    # IoT (green)
    "iot_core": "#7AA116", "greengrass": "#7AA116",
    # cost (green)
    "cost_explorer": "#7AA116",
    # dev tools (blue)
    "codebuild": "#C925D1",
    # generic (dark)
    "users": "#232F3E", "client": "#232F3E", "traditional_server": "#232F3E",
    "command_line_interface": "#232F3E", "management_console": "#232F3E", "aws_cloud": "#232F3E",
}

STANDALONE = {"client", "traditional_server", "users", "internet"}  # shape=mxgraph.aws4.<name>
ALB_SHAPE = "application_load_balancer"

RES_STYLE = (
    "sketch=0;points=[[0,0,0],[0.25,0,0],[0.5,0,0],[0.75,0,0],[1,0,0],[0,1,0],[0.25,1,0],[0.5,1,0],"
    "[0.75,1,0],[1,1,0],[0,0.25,0],[0,0.5,0],[0,0.75,0],[1,0.25,0],[1,0.5,0],[1,0.75,0]];"
    "outlineConnect=0;fontColor=#232F3E;fillColor={color};strokeColor=#ffffff;dashed=0;"
    "verticalLabelPosition=bottom;verticalAlign=top;align=center;html=1;fontSize=12;fontStyle=0;"
    "aspect=fixed;shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.{icon};"
)
STANDALONE_STYLE = (
    "sketch=0;outlineConnect=0;fontColor=#232F3E;gradientColor=none;fillColor={color};strokeColor=none;"
    "dashed=0;verticalLabelPosition=bottom;verticalAlign=top;align=center;html=1;fontSize=12;fontStyle=0;"
    "aspect=fixed;pointerEvents=1;shape=mxgraph.aws4.{icon};"
)
ALB_STYLE = (
    "sketch=0;outlineConnect=0;fontColor=#232F3E;gradientColor=none;fillColor=#8C4FFF;strokeColor=none;"
    "dashed=0;verticalLabelPosition=bottom;verticalAlign=top;align=center;html=1;fontSize=12;fontStyle=0;"
    "aspect=fixed;pointerEvents=1;shape=mxgraph.aws4.application_load_balancer;"
)
GROUP_STYLE = (
    "points=[[0,0],[0.25,0],[0.5,0],[0.75,0],[1,0],[1,0.25],[1,0.5],[1,0.75],[1,1],[0.75,1],[0.5,1],"
    "[0.25,1],[0,1],[0,0.75],[0,0.5],[0,0.25]];outlineConnect=0;gradientColor=none;html=1;whiteSpace=wrap;"
    "fontSize=12;fontStyle=0;container=1;dropTarget=1;pointerEvents=0;collapsible=0;recursiveResize=0;"
    "shape=mxgraph.aws4.group;grIcon=mxgraph.aws4.{gr};strokeColor={stroke};fillColor=none;"
    "verticalAlign=top;align=left;spacingLeft=30;fontColor={stroke};dashed={dashed};"
)
GROUPS = {
    "cloud": ("group_aws_cloud_alt", "#232F3E", 0),
    "vpc": ("group_vpc2", "#8C4FFF", 0),
    "private": ("group_security_group", "#147EBA", 0),
    "generic": ("group_security_group", "#5A6C86", 1),
    "onprem": ("group_on_premise", "#5A6C86", 0),
}
BOX_STYLE = (
    "rounded=1;whiteSpace=wrap;html=1;fillColor=#FFFFFF;strokeColor=#5A6C86;fontColor=#232F3E;"
    "fontSize=11;align=left;verticalAlign=top;spacing=6;"
)
NOTE_STYLE = (
    "text;html=1;align=left;verticalAlign=top;whiteSpace=wrap;rounded=0;fontSize=11;fontColor=#37475A;"
    "spacing=4;"
)
EDGE_BASE = (
    "edgeStyle=orthogonalEdgeStyle;rounded=1;orthogonalLoop=1;jettySize=auto;html=1;strokeWidth=2;"
    "strokeColor=#545B64;fontSize=11;labelBackgroundColor=#F5F5F5;"
)

CANVAS_W, CANVAS_H = 2500, 1500


def esc(s: str) -> str:
    """Escape label text for an mxCell value attribute.

    draw.io renders values as HTML (html=1), so literal <, > and & must be HTML-escaped first
    (otherwise "<name>" disappears as an unknown tag), and the result must then be XML-attribute
    escaped. Newlines become real <br> tags.
    """
    t = s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")  # HTML text level
    t = t.replace("&", "&amp;").replace('"', "&quot;")  # XML attribute level
    return t.replace("\n", "&lt;br&gt;")


@dataclass
class Node:
    id: str
    icon: str
    label: str
    x: int
    y: int
    size: int = 78
    parent: str = "1"
    # raw box (non-icon) support
    box: bool = False
    w: int = 0
    h: int = 0


@dataclass
class Group:
    id: str
    kind: str
    label: str
    x: int
    y: int
    w: int
    h: int
    parent: str = "1"


@dataclass
class Edge:
    src: str
    dst: str
    label: str = ""
    dashed: bool = False
    color: str | None = None
    exit: tuple[float, float] | None = None
    entry: tuple[float, float] | None = None
    bidir: bool = False
    points: list[tuple[int, int]] | None = None  # absolute waypoints


@dataclass
class Page:
    id: str
    name: str
    title: str
    subtitle: str
    groups: list[Group] = field(default_factory=list)
    nodes: list[Node] = field(default_factory=list)
    edges: list[Edge] = field(default_factory=list)
    notes: list[tuple[int, int, int, int, str]] = field(default_factory=list)  # x,y,w,h,text
    width: int = CANVAS_W
    height: int = CANVAS_H

    def g(self, *a, **k):
        grp = Group(*a, **k)
        self.groups.append(grp)
        return grp

    def n(self, *a, **k):
        node = Node(*a, **k)
        self.nodes.append(node)
        return node

    def box(self, id, label, x, y, w, h, parent="1"):
        node = Node(id, "", label, x, y, parent=parent, box=True, w=w, h=h)
        self.nodes.append(node)
        return node

    def e(self, *a, **k):
        self.edges.append(Edge(*a, **k))

    def note(self, x, y, w, h, text):
        self.notes.append((x, y, w, h, text))


def abs_geom(page: Page, cell_id: str) -> tuple[int, int, int, int]:
    """Absolute geometry of a node or group (walks parent containers)."""
    for n in page.nodes:
        if n.id == cell_id:
            w, h = (n.w, n.h) if n.box else (n.size, n.size)
            px, py = parent_origin(page, n.parent)
            return n.x + px, n.y + py, w, h
    for g in page.groups:
        if g.id == cell_id:
            px, py = parent_origin(page, g.parent)
            return g.x + px, g.y + py, g.w, g.h
    raise KeyError(cell_id)


def parent_origin(page: Page, parent: str) -> tuple[int, int]:
    if parent == "1":
        return 0, 0
    for g in page.groups:
        if g.id == parent:
            px, py = parent_origin(page, g.parent)
            return g.x + px, g.y + py
    raise KeyError(parent)


def auto_ports(page: Page, e: Edge) -> tuple[tuple[float, float], tuple[float, float]]:
    sx, sy, sw, sh = abs_geom(page, e.src)
    tx, ty, tw, th = abs_geom(page, e.dst)
    scx, scy = sx + sw / 2, sy + sh / 2
    tcx, tcy = tx + tw / 2, ty + th / 2
    dx, dy = tcx - scx, tcy - scy
    if abs(dx) >= abs(dy):
        if dx > 0:
            return (1, 0.5), (0, 0.5)
        return (0, 0.5), (1, 0.5)
    if dy > 0:
        return (0.5, 1), (0.5, 0)
    return (0.5, 0), (0.5, 1)


def render_page(page: Page) -> str:
    cells: list[str] = []
    cells.append(
        f'<mxCell id="bg" value="" style="rounded=0;whiteSpace=wrap;html=1;fillColor=#F5F5F5;strokeColor=none;" '
        f'vertex="1" parent="1"><mxGeometry x="0" y="0" width="{page.width}" height="{page.height}" as="geometry"/></mxCell>'
    )
    cells.append(
        f'<mxCell id="title" value="&lt;b&gt;&lt;font style=&quot;font-size:18px&quot;&gt;{esc(page.title)}&lt;/font&gt;&lt;/b&gt;&lt;br&gt;'
        f'{esc(page.subtitle)}&lt;br&gt;Physical AI Dashboard | 2026-09-18 | v1" '
        f'style="text;html=1;align=left;verticalAlign=top;whiteSpace=wrap;rounded=0;fontSize=12;spacing=8;" '
        f'vertex="1" parent="1"><mxGeometry x="40" y="24" width="1100" height="80" as="geometry"/></mxCell>'
    )
    for g in page.groups:
        gr, stroke, dashed = GROUPS[g.kind]
        style = GROUP_STYLE.format(gr=gr, stroke=stroke, dashed=dashed)
        cells.append(
            f'<mxCell id="{g.id}" value="{esc(g.label)}" style="{style}" vertex="1" parent="{g.parent}">'
            f'<mxGeometry x="{g.x}" y="{g.y}" width="{g.w}" height="{g.h}" as="geometry"/></mxCell>'
        )
    for n in page.nodes:
        if n.box:
            cells.append(
                f'<mxCell id="{n.id}" value="{esc(n.label)}" style="{BOX_STYLE}" vertex="1" parent="{n.parent}">'
                f'<mxGeometry x="{n.x}" y="{n.y}" width="{n.w}" height="{n.h}" as="geometry"/></mxCell>'
            )
            continue
        if n.icon == ALB_SHAPE:
            style = ALB_STYLE
        elif n.icon in STANDALONE:
            style = STANDALONE_STYLE.format(color=ICON_COLORS.get(n.icon, "#232F3E"), icon=n.icon)
        else:
            if n.icon not in ICON_COLORS:
                raise ValueError(f"unverified icon {n.icon}")
            style = RES_STYLE.format(color=ICON_COLORS[n.icon], icon=n.icon)
        cells.append(
            f'<mxCell id="{n.id}" value="{esc(n.label)}" style="{style}" vertex="1" parent="{n.parent}">'
            f'<mxGeometry x="{n.x}" y="{n.y}" width="{n.size}" height="{n.size}" as="geometry"/></mxCell>'
        )
    for i, (x, y, w, h, text) in enumerate(page.notes):
        cells.append(
            f'<mxCell id="note{i}" value="{esc(text)}" style="{NOTE_STYLE}" vertex="1" parent="1">'
            f'<mxGeometry x="{x}" y="{y}" width="{w}" height="{h}" as="geometry"/></mxCell>'
        )
    for i, e in enumerate(page.edges):
        ex, en = auto_ports(page, e)
        if e.exit:
            ex = e.exit
        if e.entry:
            en = e.entry
        style = EDGE_BASE + (
            f"exitX={ex[0]};exitY={ex[1]};exitDx=0;exitDy=0;entryX={en[0]};entryY={en[1]};entryDx=0;entryDy=0;"
        )
        if e.dashed:
            style += "dashed=1;"
        if e.color:
            style += f"strokeColor={e.color};"
        if e.bidir:
            style += "startArrow=classic;startFill=1;"
        value = f' value="{esc(e.label)}"' if e.label else ""
        geom = '<mxGeometry relative="1" as="geometry"/>'
        if e.points:
            pts = "".join(f'<mxPoint x="{x}" y="{y}"/>' for x, y in e.points)
            geom = f'<mxGeometry relative="1" as="geometry"><Array as="points">{pts}</Array></mxGeometry>'
        cells.append(
            f'<mxCell id="e{i}"{value} style="{style}" edge="1" parent="1" source="{e.src}" target="{e.dst}">'
            f'{geom}</mxCell>'
        )
    body = "".join(cells)
    return (
        f'<diagram id="{page.id}" name="{esc(page.name)}">'
        f'<mxGraphModel dx="2800" dy="1600" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" '
        f'fold="1" page="1" pageScale="1" pageWidth="{page.width}" pageHeight="{page.height}" math="0" shadow="0">'
        f'<root><mxCell id="0"/><mxCell id="1" parent="0"/>{body}</root></mxGraphModel></diagram>'
    )


# ---------------------------------------------------------------------------
# Pages
# ---------------------------------------------------------------------------
pages: list[Page] = []


def page_overview() -> Page:
    p = Page("p00", "00 전체 아키텍처", "전체 배포 아키텍처 (CDK 스택 PhysicalAiDashboard)",
             "브라우저·CLI → Route 53/ALB/Cognito → ECS Fargate(web·controller·gateway) → HyperPod EKS · DynamoDB · S3 · SageMaker")
    p.width = 2700
    p.height = 1600
    p.n("users", "users", "연구자 / 관리자\n브라우저 · pai CLI", 60, 560)
    p.g("cloud", "cloud", "AWS 계정 913524902871 · us-east-1", 260, 110, 2380, 1400)
    p.n("r53", "route_53", "Route 53\nphysical-ai.hi-yoo.com\n*.apps.physical-ai.hi-yoo.com", 60, 240, parent="cloud")
    p.n("acm", "certificate_manager", "ACM 인증서\n도메인 + *.apps SAN", 60, 500, parent="cloud")
    p.n("cognito", "cognito", "Cognito User Pool\nManaged Login v2 (Hosted UI)\ngroups: admins · researchers · viewers", 330, 60, parent="cloud")
    p.n("alb", "application_load_balancer", "ALB :443\nauthenticate-cognito → web\nHost *.apps.* → gateway\n/api/v1/* · /api/health 우회", 330, 450, parent="cloud")
    p.g("vpc", "vpc", "기존 HyperPod EKS VPC (private subnets)", 560, 160, 1000, 1000, parent="cloud")
    p.g("ecs", "private", "ECS Fargate 클러스터 physical-ai-dashboard (같은 웹 이미지, 다른 command)", 40, 60, 380, 880, parent="vpc")
    p.n("web", "fargate", "web (:3000)\nNext.js 16 UI + API\n512 CPU / 1 GiB\nSageMaker · AMP · CloudWatch · ECR ·\nCost Explorer 를 태스크 역할로 직접 호출", 150, 90, parent="ecs")
    p.n("ctrl", "fargate", "controller (:3001)\nDAG · Kueue 제출\n결과 게시 · 워커 루프\n2048 CPU / 4 GiB", 150, 380, parent="ecs")
    p.n("gw", "fargate", "gateway (:3002)\n세션 호스트 프록시\nexec / port-forward / DCV 터널", 150, 680, parent="ecs")
    p.n("cmap", "cloud_map", "Cloud Map\ncontroller.<prefix>.internal\n(RUNTIME_API_URL)", 560, 560, parent="vpc")
    p.n("eks", "eks", "HyperPod EKS 클러스터\nKueue · JobSet · Pod Identity\nns: hyperpod-ns-team-a/b, rl", 800, 60, parent="vpc")
    p.n("hp", "sagemaker", "SageMaker HyperPod 노드\ncpu-c5-4x ×2 · gpu-g5-8x ×1\n레시피 Pod 실행 (ECR 이미지 pull)", 800, 380, parent="vpc")
    p.n("fsx", "fsx_for_lustre", "FSx for Lustre 1.2 TiB\n/fsx/{datasets,checkpoints,enroot}", 800, 700, parent="vpc")
    p.n("dcv", "ec2", "EC2 g5.4xlarge\nIsaac Sim 워크스테이션\nNICE DCV :8443", 560, 760, parent="vpc")
    p.n("ddb", "dynamodb", "DynamoDB (단일 테이블)\nphysical-ai-dashboard-…\n임대 · outbox · 원장", 1900, 60, parent="cloud")
    p.n("s3", "s3", "S3\n• dashboard artifacts (버전 관리)\n• hyperpod-eks-data (FSx DRA)\n• groot-sm-artifacts", 1900, 330, parent="cloud")
    p.n("sm", "sagemaker", "SageMaker AI\nPipelines · Training Jobs\nModel Registry · MLflow 서버\nComputeQuota", 1900, 600, parent="cloud")
    p.n("amp", "managed_service_for_prometheus", "Amazon Managed\nService for Prometheus\n(DCGM · Kueue · cAdvisor)", 1900, 870, parent="cloud")
    p.n("cw", "cloudwatch", "CloudWatch Logs\n/aws/ecs/<prefix>\n/aws/sagemaker/Clusters/*\n/aws/sagemaker/TrainingJobs", 2180, 870, parent="cloud")
    p.n("sns", "sns", "SNS notifications\n실행 종료 알림", 1660, 760, parent="cloud")
    p.n("ecr", "ecr", "ECR\n워크로드 이미지 (mujoco · isaaclab ·\nros2 · groot · openpi · workspace)", 640, 1180, parent="cloud")
    p.n("cb", "codebuild", "CodeBuild\noperations (EKS add-on/RBAC)\nsource-image 빌드", 920, 1180, parent="cloud")
    p.n("ssm", "parameter_store", "SSM Parameter Store\n/physical-ai/projects/* (SecureString)\n자격증명 · 웹훅 secret", 1200, 1180, parent="cloud")
    p.n("ce", "cost_explorer", "Cost Explorer\nGetCostAndUsage (관리자)", 1480, 1180, parent="cloud")
    p.n("secrets", "secrets_manager", "Secrets Manager\nadmin 초기 계정 · runtime HMAC 키\nDCV SSO secret", 1760, 1180, parent="cloud")
    p.n("gg", "greengrass", "IoT Core / Greengrass v2\nthing group · inference component", 2040, 1180, parent="cloud")
    # edges (absolute coordinates: cloud +260/+110, vpc +820/+270, ecs +860/+330)
    p.e("users", "r53", "DNS", dashed=True)
    p.e("users", "alb", "HTTPS")
    p.e("alb", "cognito", "OIDC 로그인 / JWT", dashed=True, exit=(0.5, 0), entry=(0.5, 1))
    p.e("alb", "web", "x-amzn-oidc-*", exit=(1, 0.5), entry=(0, 0.5))
    p.e("alb", "gw", "*.apps.* 세션 호스트", exit=(1, 0.75), entry=(0, 0.5), points=[(760, 1069)])
    p.e("acm", "alb", "TLS", dashed=True, exit=(1, 0.5), entry=(0, 0.75))
    p.e("web", "eks", "Kubernetes API (STS 서명 토큰)", exit=(1, 0.5), entry=(0, 0.25))
    p.e("ctrl", "eks", "Job / JobSet 생성 · 감시", exit=(1, 0.25), entry=(0, 0.5), color="#8C4FFF")
    p.e("gw", "eks", "exec / port-forward WebSocket", exit=(1, 0.25), entry=(0, 0.75))
    p.e("ctrl", "cmap", "", dashed=True, exit=(1, 0.75), entry=(0, 0.5))
    p.e("cmap", "hp", "Pod → runtime API", dashed=True, exit=(1, 0.5), entry=(0, 0.75))
    p.e("gw", "dcv", "SSM 포트포워딩 8443", exit=(1, 0.75), entry=(0, 0.5))
    p.e("hp", "eks", "노드 그룹", dashed=True, exit=(0.5, 0), entry=(0.5, 1))
    p.e("hp", "fsx", "", dashed=True, exit=(0.5, 1), entry=(0.5, 0))
    p.e("fsx", "s3", "DRA import / export", dashed=True, exit=(1, 0.5), entry=(0, 0.75))
    p.e("web", "ddb", "원장 조회·갱신", exit=(0.25, 0), entry=(0.5, 0), points=[(1030, 250), (2199, 250)])
    p.e("ctrl", "ddb", "5초 reconcile · 임대 · outbox", exit=(0.75, 0), entry=(0, 0.5), color="#8C4FFF", points=[(1068, 300), (2100, 300), (2100, 209)])
    p.e("ctrl", "s3", "manifest · snapshot", exit=(1, 0.5), entry=(0, 0.5), color="#8C4FFF", points=[(1200, 749), (1200, 540), (2150, 540), (2150, 479)])
    p.e("ctrl", "sns", "종료 알림", dashed=True, exit=(1, 0.75), entry=(0, 0.5))
    p.note(300, 1470, 2300, 60,
           "실선: 요청/데이터 경로 · 점선: 비동기/보조 · 보라색: controller 워커 루프. web → SageMaker/AMP/CloudWatch/ECR/Cost Explorer/Cognito/IoT 호출은 페이지 01·04·06·07·08 참조.")
    return p


def page_auth() -> Page:
    p = Page("p01", "01 로그인·인증·권한", "로그인 · 세션 · 권한 (ALB + Cognito, API 토큰, 감사 로그)",
             "화면: 로그인(Cognito Hosted UI) · 사이드바 로그아웃 · 자격증명·API 토큰 · 플랫폼 설정(사용자/감사)")
    p.n("browser", "client", "브라우저\n(Cognito 세션 12h)", 60, 300)
    p.n("cli", "command_line_interface", "pai CLI\nAuthorization: Bearer pai_…", 60, 760)
    p.g("cloud", "cloud", "AWS", 300, 110, 2140, 1300)
    p.n("alb", "application_load_balancer", "ALB HTTPS 리스너\n기본 동작 authenticate-cognito\n규칙: /api/health, /api/logout, /api/v1/* 우회", 120, 300, parent="cloud")
    p.n("cognito", "cognito", "Cognito User Pool us-east-1_YpnKXG6LG\nManaged Login v2 (다크 테마)\n앱 클라이언트 alb · scopes openid/email/profile", 120, 40, parent="cloud")
    p.box("admin", "플랫폼 설정 (관리자) → Cognito\nListUsers · ListGroups · AdminCreateUser(SUPPRESS) · AdminSetUserPassword(Permanent)\nAdminAddUserToGroup / AdminRemoveUserFromGroup · 감사 로그 조회 · SYS/SETTINGS 저장",
          40, 600, 620, 110, parent="cloud")
    p.box("tokens", "자격증명·API 토큰 화면\n토큰 pai_<43자>는 SHA-256 해시만 저장, 1–30일 만료,\nscope workflows/datasets/sessions/models/metrics (:read/:write)\nroleCeiling = 실시간 Cognito AdminGetUser + AdminListGroupsForUser ∧ 프로젝트 멤버십 (캐시 없음)\n자격증명은 값 대신 ref 를 워크플로에 전달, rotate 는 PutParameter Overwrite",
          40, 760, 620, 150, parent="cloud")
    p.g("vpc", "vpc", "VPC · ECS Fargate", 740, 200, 760, 840, parent="cloud")
    p.box("proxy", "web · src/proxy.ts (Next.js 미들웨어)\n"
                   "1. x-amzn-oidc-data (ES256) 서명 검증 — ELB 공개키, signer == ALB ARN, iss == user pool\n"
                   "2. x-amzn-oidc-accesstoken → Cognito JWKS 검증, cognito:groups 추출\n"
                   "3. 신뢰 헤더 x-pai-user / subject / email / role / project 주입\n"
                   "4. /api/v1/* + Bearer 토큰 → SHA-256 조회 → 프로젝트·scope 제한 후 /api/* 로 재작성",
          60, 60, 640, 190, parent="vpc")
    p.box("route", "route(minRole, handler, {audit}) · src/server/api.ts\n"
                   "역할 순위 viewer < researcher < admin (Cognito 그룹 admins / researchers)\n"
                   "프로젝트 역할 viewer / researcher / project-admin (DynamoDB PROJECT#<id> 멤버)\n"
                   "브라우저 변경 요청은 same-origin 강제 · 모든 non-GET 은 AUDIT 파티션에 90일 기록",
          60, 300, 640, 150, parent="vpc")
    p.n("web", "fargate", "web (Next.js)", 340, 520, parent="vpc")
    p.box("me", "GET /api/me → 사용자·역할·features·resources·선택 프로젝트\nPOST /api/auth/logout → gateway 세션 회수 → GET /api/logout → Cognito /logout",
          60, 680, 640, 90, parent="vpc")
    p.n("ddb", "dynamodb", "DynamoDB\nAPI_TOKEN#<sha256> · PROJECT#<id>/TOKEN#\nPROJECT#<id>/META 멤버 · AUDIT", 1620, 300, parent="cloud")
    p.n("ssm", "parameter_store", "SSM Parameter Store\n/physical-ai/projects/<p>/{users/<sha>|shared}/<id>\n(HF/NGC 자격증명 SecureString)", 1620, 760, parent="cloud")
    p.n("secrets", "secrets_manager", "Secrets Manager\nphysical-ai-dashboard/<acct>/admin\n초기 관리자 계정", 1620, 40, parent="cloud")
    p.n("iam", "identity_and_access_management", "IAM 태스크 역할\nweb · controller · gateway\n(EKS access entry 그룹 physical-ai:*)", 1920, 300, parent="cloud")
    p.e("browser", "alb", "HTTPS")
    p.e("alb", "cognito", "302 → Hosted UI 로그인\n코드 교환 → 세션 쿠키", dashed=True, exit=(0.5, 0), entry=(0.5, 1))
    p.e("alb", "proxy", "x-amzn-oidc-data\nx-amzn-oidc-accesstoken", exit=(1, 0.25), entry=(0, 0.5))
    p.e("cli", "alb", "/api/v1/* (Cognito 우회)", exit=(1, 0.5), entry=(0, 0.75))
    p.e("proxy", "route", "", exit=(0.5, 1), entry=(0.5, 0))
    p.e("route", "web", "", exit=(0.5, 1), entry=(0.5, 0))
    p.e("web", "me", "", exit=(0.5, 1), entry=(0.5, 0))
    p.e("proxy", "ddb", "토큰 해시 조회", exit=(1, 0.5), entry=(0, 0.25))
    p.e("route", "ddb", "감사 · 멤버십", exit=(1, 0.5), entry=(0, 0.75))
    p.e("proxy", "cognito", "JWKS · ELB 공개키", dashed=True, exit=(0.25, 0), entry=(1, 0.5))
    p.e("admin", "cognito", "Admin* API", dashed=True, exit=(0.5, 0), entry=(0.5, 1))
    p.e("tokens", "ssm", "PutParameter SecureString", exit=(1, 0.5), entry=(0, 0.5))
    p.e("tokens", "ddb", "토큰 해시 · 자격증명 레코드", exit=(1, 0.25), entry=(0, 1))
    p.e("secrets", "cognito", "부트스트랩 admin 생성 (CDK 커스텀 리소스)", dashed=True, exit=(0, 0.5), entry=(1, 0.5))
    p.e("web", "iam", "SDK 호출은 태스크 역할로", dashed=True, exit=(1, 0.5), entry=(0.5, 1))
    return p


def page_workflows() -> Page:
    p = Page("p02", "02 실행(워크플로)", "실행(Runs) · 새 실행 · 실행 상세 (DAG · 작업 · 로그 · 이벤트 · 메트릭 · 산출물 · 스펙)",
             "레시피 제출 → 이미지 사전검사 → DynamoDB 원장 → controller(5초 reconcile) → Kueue Job/JobSet on HyperPod EKS → FSx → S3 게시 → Artifacts 탭")
    p.n("browser", "client", "브라우저\n새 실행 (3단계 마법사)\n실행 상세 탭", 60, 420)
    p.g("cloud", "cloud", "AWS", 300, 110, 2160, 1340)
    p.n("web", "fargate", "web API\nPOST /api/workflows (idempotency-key)\nPOST /api/workflows/validate", 100, 420, parent="cloud")
    p.n("ecr", "ecr", "ECR (private)\nDescribeImages · GetAuthorizationToken\nmanifest/config digest 검사", 100, 120, parent="cloud")
    p.n("ddb", "dynamodb", "DynamoDB\nWF#<id>/META · TASK · EVENT\nDS# 게시 버전 · 실행 임대", 420, 120, parent="cloud")
    p.n("ctrl", "fargate", "controller (Fargate)\n컴파일 · Kueue 제출 · 재시도\n결과 게시", 1000, 420, parent="cloud")
    p.g("eks", "vpc", "HyperPod EKS · 프로젝트 네임스페이스 hyperpod-ns-team-a", 1240, 80, 860, 700, parent="cloud")
    p.box("job", "batch/v1 Job 또는 jobset.x-k8s.io JobSet\nlabels kueue.x-k8s.io/queue-name=<ns>-localqueue · priority-class\nSA pai-workflow (Pod Identity) · FSx PVC subPath projects/<p>/…\nrun-as non-root · NetworkPolicy (IMDS·PodIdentity egress 차단)\nlive: true → MJPEG 사이드카 (pai-live :8090, PAI_LIVE_DIR)",
          40, 60, 500, 170, parent="eks")
    p.n("kueue", "container_2", "Kueue ClusterQueue /\nLocalQueue 승인", 620, 80, parent="eks")
    p.n("pod", "container_2", "레시피 Pod\n(mujoco · isaaclab · groot …)\n+ runtime 래퍼", 220, 330, parent="eks")
    p.n("fsx", "fsx_for_lustre", "FSx for Lustre\n/fsx/checkpoints/projects/<p>/runs/<run>/\nattempts/<n>/<task>", 620, 330, parent="eks")
    p.n("cmap", "cloud_map", "Cloud Map → controller\n/runtime/* (HMAC capability)\n/tracking/* (MLflow proxy)", 220, 540, parent="eks")
    p.n("s3data", "s3", "S3 hyperpod-eks-data\ncheckpoints/… (FSx DRA export)\nCreateDataRepositoryTask", 1500, 880, parent="cloud")
    p.n("s3art", "s3", "S3 dashboard artifacts (버전 관리)\nprojects/<p>/datasets/<name>/versions/vN/\nmanifest.json + SHA-256 검증 사본", 1860, 880, parent="cloud")
    p.n("amp", "managed_service_for_prometheus", "AMP query_range (메트릭 탭)\nweb 이 직접 질의: DCGM GPU util/mem\ncAdvisor CPU/mem", 700, 1120, parent="cloud")
    p.n("cw", "cloudwatch", "CloudWatch Logs (참고)\nFluentBit 컨테이너 로그\n/aws/sagemaker/Clusters/<cluster>", 1300, 1120, parent="cloud")
    p.n("sns", "sns", "SNS 알림\n(notifyOn 상태)", 1000, 1120, parent="cloud")
    p.n("hook", "internet", "웹훅 수신자 (HTTPS)\nx-pai-signature HMAC-SHA256", 100, 1120, parent="cloud")
    p.n("gw", "fargate", "gateway\n<session>.apps.<domain>\nport-forward → MJPEG iframe", 400, 1120, parent="cloud")
    p.box("logs", "로그 탭: web 이 Kubernetes API pods/<name>/log 를 직접 읽어 SSE 로 전달(55초 연결 · 타임스탬프 재접속). 저장하지 않음 · Pod 삭제 후 pod-gone 안내 · 시도별 Secret 기준 redaction",
          1500, 1120, 620, 90, parent="cloud")
    p.box("artifacts", "산출물 탭: 게시된 READY 버전의 고정 manifest 를 읽어 이미지·영상 갤러리 / JSON 인라인 / 가중치 다운로드\n(VersionId 고정 presigned GET 300초). 사용량 패널: task ledger 기반 요청 CPU/GPU 시간(실제 이용률·청구액 아님)",
          1500, 1240, 620, 80, parent="cloud")
    p.e("browser", "web", "YAML + 파라미터")
    p.e("web", "ecr", "이미지 프로필 preflight\n(digest 고정, 미승인 시 422)", exit=(0.5, 0), entry=(0.5, 1))
    p.e("web", "ddb", "WF# 생성 · outbox", exit=(1, 0.25), entry=(0, 0.75))
    p.e("ddb", "ctrl", "5초 reconcile (임대)", exit=(1, 0.5), entry=(0, 0.25), color="#8C4FFF")
    p.e("ctrl", "ddb", "상태·이벤트", exit=(0.25, 0), entry=(1, 0.5), color="#8C4FFF")
    p.e("ctrl", "job", "K8s API 생성 · watch", exit=(1, 0.25), entry=(0, 0.5), color="#8C4FFF")
    p.e("job", "kueue", "승인 대기", dashed=True)
    p.e("kueue", "pod", "admit → 스케줄", dashed=True, exit=(0, 1), entry=(1, 0.25))
    p.e("pod", "fsx", "입력 읽기 · 출력 쓰기")
    p.e("pod", "cmap", "heartbeat · 결과 신고", dashed=True)
    p.e("fsx", "s3data", "DRA export (controller 트리거)", exit=(0.5, 1), entry=(0.5, 0))
    p.e("s3data", "s3art", "SHA-256 검증 후\nCopyObject / multipart copy")
    p.e("ctrl", "s3art", "게시 · manifest", exit=(0.75, 1), entry=(0, 0.25), color="#8C4FFF")
    p.e("ctrl", "sns", "종료 알림", dashed=True, exit=(0.5, 1), entry=(0.5, 0))
    p.e("web", "hook", "종료 이벤트 웹훅\n(controller 워커가 서명·전달, 8회 재시도)", dashed=True, exit=(0.5, 1), entry=(0.5, 0))
    p.e("gw", "pod", "실시간 보기: port-forward pai-live → iframe", dashed=True, exit=(0.5, 0), entry=(0, 1))
    p.e("web", "s3art", "Artifacts 탭 presign (VersionId)", dashed=True, exit=(0.75, 1), entry=(0, 0.75))
    return p


def page_datasets() -> Page:
    p = Page("p03", "03 데이터셋", "데이터셋 · 데이터셋 상세 (PENDING → 검증 → READY, 불변 버전, 계보)",
             "브라우저 멀티파트 업로드(SHA-256) → S3 데이터 버킷 → 워커 finalize → 아티팩트 버킷 snapshot + manifest → READY → FSx 자동 import")
    p.n("browser", "client", "브라우저\n데이터셋 목록 · 상세\n업로드 · 검증 · 다운로드", 60, 480)
    p.g("cloud", "cloud", "AWS", 300, 110, 2160, 1300)
    p.n("web", "fargate", "web API\n/api/datasets/* · /versions/:v/uploads/*\n/versions/:v/download", 120, 480, parent="cloud")
    p.n("ddb", "dynamodb", "DynamoDB\nDS#<name>/META · V#000001 · UPLOAD#…\nFINALIZE#<v> (gsi1 TYPE#DATASET_FINALIZATION)\nREFERENCE#… (계보)", 520, 120, parent="cloud")
    p.n("s3data", "s3", "S3 hyperpod-eks-data\ndatasets/<name>/v<N>/… (staging)\nCreateMultipartUpload (COMPOSITE SHA256)\nUploadPart presign 900s · CompleteMultipartUpload", 520, 480, parent="cloud")
    p.n("ctrl", "fargate", "controller 워커\nfinalizePendingVersions (10초)\nsnapshotPrefix + streamed SHA-256", 920, 480, parent="cloud")
    p.n("s3art", "s3", "S3 dashboard artifacts (버전 관리)\nprojects/<p>/datasets/<name>/versions/v<N>/\nmanifest.json (manifestVersionId · hash 고정)", 1320, 480, parent="cloud")
    p.g("vpc", "vpc", "HyperPod EKS VPC", 1180, 800, 900, 400, parent="cloud")
    p.n("fsx", "fsx_for_lustre", "FSx for Lustre\n/fsx/datasets/<name>/v<N> (DRA auto-import)\n/fsx/datasets/projects/<p>/<name>/v<N>", 140, 120, parent="vpc")
    p.n("pod", "container_2", "레시피 Pod\n입력을 로컬 파일로 읽음\n(task 전체 1,024 파일 · 64 그룹)", 620, 120, parent="vpc")
    p.n("hf", "internet", "Hugging Face Hub\n(HF 가져오기 레시피)", 120, 880, parent="cloud")
    p.n("eks2", "eks", "hf-dataset-import 워크플로\n(LeRobot v3→v2.1 변환)", 520, 880, parent="cloud")
    p.box("rules", "규칙\n• READY 버전은 불변 · 참조된 버전 삭제 거부 · 삭제는 tombstone (purge 옵션 시 DeleteObjects)\n• 파일 목록/다운로드는 고정 manifest 기반, HeadObject(VersionId, ChecksumMode) 로 무결성 확인 후 presigned GET 300초\n• 검증 실적: 5 GiB+1 MiB 81 parts 재시도 후 전체 SHA-256 복원, 65 파일 hydration\n• 비관리자는 projects/<p>/ 및 datasets/projects/<p>/ 접두사로 제한 (assertStorageScope)",
          120, 1080, 980, 150, parent="cloud")
    p.e("browser", "web", "메타데이터 · part 체크섬")
    p.e("browser", "s3data", "presigned PUT (part)\n브라우저 → S3 직접", exit=(0.5, 0), entry=(0.5, 0), color="#7AA116")
    p.e("web", "ddb", "버전 상태 · 업로드 등록", exit=(0.5, 0), entry=(0, 0.5))
    p.e("web", "s3data", "Create/List/Complete/Abort\nMultipartUpload · presign")
    p.e("web", "ddb", "검증 및 버전 확정 → FINALIZE#", dashed=True, exit=(1, 0.25), entry=(0, 0.75))
    p.e("ddb", "ctrl", "GSI 폴링", dashed=True, exit=(1, 0.5), entry=(0.5, 0))
    p.e("s3data", "ctrl", "ListObjectsV2 · GetObject(VersionId)")
    p.e("ctrl", "s3art", "CopyObject / UploadPartCopy\n+ manifest.json PutObject")
    p.e("ctrl", "ddb", "state=READY (조건부 트랜잭션)", exit=(0.5, 0), entry=(1, 0.75), color="#8C4FFF")
    p.e("s3data", "fsx", "DRA auto-import", dashed=True, exit=(0.5, 1), entry=(0, 0.5))
    p.e("fsx", "pod", "로컬 파일 경로")
    p.e("hf", "eks2", "다운로드 · 변환")
    p.e("eks2", "fsx", "출력 → 게시", dashed=True, exit=(1, 0.5), entry=(0, 0.75))
    p.e("web", "s3art", "다운로드 presign (VersionId)", dashed=True, exit=(0.75, 1), entry=(0.25, 1))
    return p


def page_models() -> Page:
    p = Page("p04", "04 모델·SageMaker 학습·MLflow", "모델·평가 · SageMaker 학습(파이프라인) · 실험 비교(MLflow)",
             "SageMaker Pipeline 실행/아카이브 → 데이터셋 게시 → 모델 등록 → 품질 게이트 → Model Registry 승인 · MLflow 추적 서버 REST(SigV4)")
    p.n("browser", "client", "브라우저\n모델·평가 / SageMaker 학습 /\n실험 비교", 60, 520)
    p.g("cloud", "cloud", "AWS", 300, 110, 2160, 1340)
    p.n("web", "fargate", "web API\n/api/models · /api/evaluations\n/api/pipelines · /api/mlflow", 120, 520, parent="cloud")
    p.n("ddb", "dynamodb", "DynamoDB\nMODEL · EVALUATION · PROJECT#<p>/PIPELINE#<op>\nPIPELINE_EXECUTION#<arn> · PIPELINE_JOB#<name>\nTRACKING#<p>/EXPERIMENT#", 520, 120, parent="cloud")
    p.n("ctrl", "fargate", "controller 워커\nreconcilePipelineIntents (5초)\nreconcilePipelineArchives", 520, 520, parent="cloud")
    p.g("sm", "generic", "Amazon SageMaker AI", 880, 60, 1240, 560, parent="cloud")
    p.n("pipe", "sagemaker", "Pipeline groot-sm-finetuning-<acct>\nTransformDataset → GR00TFinetune →\nSmokeEval → SmokeGate → RegisterModel", 60, 80, parent="sm")
    p.n("train", "sagemaker_train", "Training / Processing Job\nml.g5.12xlarge · 이미지 groot-sm-training:latest\nDescribeTrainingJob", 420, 80, parent="sm")
    p.n("registry", "sagemaker_model", "Model Registry\ngroot-sm-models-<acct>\nUpdateModelPackage(Approved)", 780, 80, parent="sm")
    p.n("mlflow", "sagemaker", "MLflow 추적 서버\ngroot-mlflow-<acct>\nREST /api/2.0/mlflow (SigV4 sagemaker-mlflow)\nCreatePresignedMlflowTrackingServerUrl", 1060, 80, parent="sm")
    p.n("ecr", "ecr", "ECR groot-sm-training", 420, 360, parent="sm")
    p.n("cw", "cloudwatch", "CloudWatch Logs\n/aws/sagemaker/TrainingJobs/<job>\n(실행 상세 로그 tail)", 780, 360, parent="sm")
    p.n("s3g", "s3", "S3 groot-sm-artifacts\nmodels/groot-sm/… model.tar.gz\nmlflow-artifacts/<run>/", 1100, 720, parent="cloud")
    p.n("s3art", "s3", "S3 dashboard artifacts\nprojects/<p>/pipeline-archives/<id>/ + manifest\n→ 데이터셋 sm-output-<id> (READY)", 1500, 720, parent="cloud")
    p.g("eks", "vpc", "HyperPod EKS", 120, 800, 860, 300, parent="cloud")
    p.n("pod", "container_2", "학습 Pod (gr00t-e2e 등)\nMLFLOW_TRACKING_URI → controller /tracking", 80, 80, parent="eks")
    p.n("cmap", "cloud_map", "controller /tracking/*\nMLflow 프록시 (capability 토큰)\n실험 pai/<project>/<workflow>", 480, 80, parent="eks")
    p.box("flow", "모델 등록 흐름\n1. 워크플로/파이프라인 출력이 READY 데이터셋으로 게시 (고정 manifest · VersionId)\n2. 모델·평가 화면에서 checkpoint 파일 선택 → POST /api/models (생산 태스크 SUCCEEDED · receipts 검증)\n3. evaluation.json 연결 → POST /api/evaluations (S3 HeadObject ChecksumMode) · 영상/보고서는 presigned 302\n4. 품질 게이트(최소 회차 20 · 성공률 80% · p95 100ms 기본) 확인 → 승인 → 파이프라인 연동 모델이면 Registry 승인 전파",
          1100, 1060, 1000, 170, parent="cloud")
    p.box("mlflow_rules", "실험 비교: 실험 이름 pai/<projectId>/… 와 run 태그 pai.project_id 로 프로젝트 격리 · 최대 4개 run 학습 곡선/파라미터 비교 · 'MLflow 열기'는 관리자 presigned URL",
          1100, 1260, 1000, 60, parent="cloud")
    p.e("browser", "web", "")
    p.e("web", "ddb", "의도(intent) 기록 · 모델/평가 레코드", exit=(0.5, 0), entry=(0, 0.5))
    p.e("web", "ctrl", "", dashed=True)
    p.e("ctrl", "pipe", "StartPipelineExecution\n(ClientRequestToken=operationId)", exit=(1, 0.25), entry=(0, 0.5))
    p.e("web", "pipe", "Describe/List/Stop\nPipelineExecution · Steps", dashed=True, exit=(1, 0.25), entry=(0, 0.75))
    p.e("pipe", "train", "steps")
    p.e("train", "registry", "RegisterModel")
    p.e("ecr", "train", "", dashed=True, exit=(0.5, 0), entry=(0.5, 1))
    p.e("train", "cw", "로그", dashed=True, exit=(1, 0.75), entry=(0, 0.5))
    p.e("train", "s3g", "model.tar.gz · evaluation 출력", exit=(0.5, 1), entry=(0, 0.25))
    p.e("ctrl", "s3g", "archive: GetObject(VersionId, IfMatch)\ntar 검사 · SHA-256", exit=(0.75, 1), entry=(0, 0.5), color="#8C4FFF")
    p.e("ctrl", "s3art", "PutObject + manifest", exit=(1, 0.75), entry=(0, 0.25), color="#8C4FFF")
    p.e("web", "registry", "UpdateModelPackage Approved\n(게이트 통과 후 confirm)", dashed=True, exit=(1, 0.5), entry=(0.5, 1))
    p.e("web", "mlflow", "search experiments/runs\ngetRun · metric history", dashed=True, exit=(1, 0.75), entry=(0.25, 1))
    p.e("pod", "cmap", "REST")
    p.e("cmap", "mlflow", "SigV4 프록시", exit=(1, 0.5), entry=(0.75, 1))
    p.e("cmap", "s3g", "artifact PUT/GET\nmlflow-artifacts/*", dashed=True, exit=(1, 0.75), entry=(0, 0.75))
    p.e("web", "cw", "GetLogEvents tail", dashed=True, exit=(0.75, 0), entry=(0.5, 1))
    return p


def page_sessions() -> Page:
    p = Page("p05", "05 시뮬레이션·개발 세션", "시뮬레이션·개발 세션 (JupyterLab · code-server · TensorBoard · 터미널 · 실시간 보기 · Isaac Sim DCV)",
             "web 이 Kueue Job 으로 워크스페이스 Pod 생성 → 1회용 티켓 → <session>.apps.<domain> gateway → EKS exec/port-forward · DCV 는 SSM 터널 + frame-ancestors")
    p.n("browser", "client", "브라우저\n세션 목록 · 새 세션 · 열기\n(iframe 임베드)", 60, 520)
    p.g("cloud", "cloud", "AWS", 300, 110, 2160, 1340)
    p.n("r53", "route_53", "Route 53\n*.apps.physical-ai.hi-yoo.com → ALB", 120, 160, parent="cloud")
    p.n("alb", "application_load_balancer", "ALB\nHost *.apps.* → gateway TG :3002\n(그 외 → web)", 120, 520, parent="cloud")
    p.g("vpc", "vpc", "VPC", 460, 60, 1640, 1200, parent="cloud")
    p.n("web", "fargate", "web\nPOST /api/sessions · /:id/launch\n/api/sessions/connect", 80, 100, parent="vpc")
    p.n("gw", "fargate", "gateway\n티켓 → __Host-pai-session 쿠키\n요청마다 DynamoDB 재인가 · 5초 재검증\nOrigin/Host 검사 · 식별 헤더 제거", 80, 460, parent="vpc")
    p.n("ddb", "dynamodb", "DynamoDB\nSESS#<id>/META (CAS revision)\nGATEWAY#TICKET#<sha> (60초)\nGATEWAY#COOKIE#<sha>", 480, 280, parent="vpc")
    p.g("eks", "private", "HyperPod EKS · hyperpod-ns-team-a", 800, 60, 800, 540, parent="vpc")
    p.box("sessjob", "일시중단 Kueue batch/v1 Job (queue-name=<ns>-localqueue)\ninit: prepare.py (chown) · runtime --verify-isolation\n워크스페이스 이미지 (JupyterLab 4.6 · code-server · TensorBoard) 127.0.0.1 바인드\nFSx subPath sessions/projects/<p>/<id> · NetworkPolicy pai-sessions (ingress 차단)\nSA 에 IAM role 주석 없음 (AWS 자격증명 없음)",
          40, 60, 480, 170, parent="eks")
    p.n("pod", "container_2", "세션 Pod :8888/:8080/:6006\n또는 실행 중 태스크 Pod (터미널·파일·pai-live)", 120, 320, parent="eks")
    p.n("fsx", "fsx_for_lustre", "FSx for Lustre\n프로젝트 sessions / checkpoints", 560, 320, parent="eks")
    p.n("dcv", "ec2", "EC2 g5.4xlarge i-048cffe4cd6ad4f3e\nIsaac Sim 워크스테이션 · NICE DCV :8443\ndcv-agent HMAC 검증기 127.0.0.1:18544", 1000, 760, parent="vpc")
    p.n("ssm", "systems_manager", "SSM\nSendCommand AWS-RunShellScript (에이전트 설치)\nStartSession AWS-StartPortForwardingSession", 560, 760, parent="vpc")
    p.n("secrets", "secrets_manager", "Secrets Manager\nDCV SSO secret (HMAC 토큰 aud=pai-dcv 120초)\nDCV 자격증명", 1300, 760, parent="vpc")
    p.n("s3", "s3", "S3 (CDK asset)\ndcv-agent.zip → bootstrap.py", 560, 1020, parent="vpc")
    p.n("ec2api", "ec2", "EC2 API\nDescribeInstances · Start/StopInstances\n(관리자 워크스테이션 제어)", 1000, 1020, parent="vpc")
    p.box("ctrl", "controller 워커: 만료 세션 정리 · DCV 세션 정리 · DCV 설정 reconcile (5초) · 워크플로 취소 시 세션 회수",
          1000, 1180, 600, 50, parent="vpc")
    p.e("browser", "r53", "DNS", dashed=True, exit=(0.5, 0), entry=(0, 0.5))
    p.e("browser", "alb", "HTTPS")
    p.e("alb", "web", "/api/sessions", exit=(1, 0.25), entry=(0, 0.5))
    p.e("alb", "gw", "https://<id>.apps.<domain>/?ticket=…", exit=(1, 0.75), entry=(0, 0.5))
    p.e("web", "sessjob", "K8s API: Job 생성 · Pod 준비 확인", exit=(1, 0.5), entry=(0, 0.5))
    p.e("web", "ddb", "세션 · 티켓 발급 (60초 해시)", exit=(1, 0.75), entry=(0, 0.25))
    p.e("gw", "ddb", "티켓 교환 (트랜잭션) · 재인가", exit=(1, 0.25), entry=(0, 0.75))
    p.e("sessjob", "pod", "", dashed=True, exit=(0.5, 1), entry=(0.5, 0))
    p.e("gw", "pod", "EKS API pods/<name>/portforward · exec\n(WebSocket v4.channel.k8s.io)", exit=(1, 0.5), entry=(0, 0.5))
    p.e("pod", "fsx", "")
    p.e("gw", "ssm", "kind=dcv: StartSession 포트포워딩\n(session-manager-plugin)", exit=(0.5, 1), entry=(0, 0.5))
    p.e("ssm", "dcv", "127.0.0.1 → :8443 TLS")
    p.e("gw", "secrets", "authToken 서명", dashed=True, exit=(0.75, 1), entry=(0, 0.25))
    p.e("web", "ssm", "관리자 '설정': SendCommand", dashed=True, exit=(1, 0.75), entry=(0.5, 0))
    p.e("s3", "dcv", "에이전트 설치 스크립트", dashed=True, exit=(1, 0.5), entry=(0, 0.75))
    p.e("web", "ec2api", "Start/Stop", dashed=True, exit=(0.5, 1), entry=(0, 0.5))
    p.height = 1600
    p.note(300, 1470, 2100, 80,
           "DCV 임베드: gateway 가 DCV 응답의 X-Frame-Options 를 제거하고 CSP frame-ancestors 'self' <대시보드 origin> 으로 교체 (kind=dcv 세션에만). '여기서 보기' 는 iframe, '새 창에서 열기' 는 새 탭.\n\n실시간 보기: 태스크 YAML live: true → MJPEG 사이드카 → port-forward 세션 → 실행 상세 iframe. 실행 소유자·RUNNING 태스크에서만.")
    return p


def page_cluster() -> Page:
    p = Page("p06", "06 컴퓨트·대기열·K8s 작업·메트릭", "컴퓨트 · 대기열·할당량 · Kubernetes 작업 · 메트릭",
             "SageMaker HyperPod API + Kubernetes API(EKS, STS 토큰) + Kueue CRD + Amazon Managed Prometheus(SigV4) — 화면의 모든 숫자는 Describe/Query 응답값")
    p.n("browser", "client", "브라우저\n컴퓨트 / 대기열 / 작업 / 메트릭", 60, 600)
    p.width = 2850
    p.g("cloud", "cloud", "AWS", 300, 110, 2480, 1340)
    p.n("web", "fargate", "web API\n/api/clusters/* · /api/queues · /api/quotas\n/api/k8s/* · /api/metrics/query", 120, 600, parent="cloud")
    p.g("hp", "generic", "Amazon SageMaker HyperPod", 460, 60, 760, 460, parent="cloud")
    p.n("hpapi", "sagemaker", "HyperPod API\nDescribeCluster · ListClusterNodes · DescribeClusterNode\nListClusterEvents · UpdateCluster(스케일 아웃)\nBatchDeleteClusterNodes(스케일 인)", 60, 80, parent="hp")
    p.n("quota", "sagemaker", "Task governance\nList/Describe/Create/Delete ComputeQuota\nClusterSchedulerConfig", 420, 80, parent="hp")
    p.n("ec2", "ec2", "EC2 DescribeInstanceTypes\n(vCPU · 메모리 · GPU 카탈로그, 6h 캐시)", 420, 300, parent="hp")
    p.g("eks", "vpc", "HyperPod EKS (Kubernetes API · EKS DescribeCluster + presigned STS 토큰)", 1260, 60, 1160, 640, parent="cloud")
    p.n("eksapi", "eks", "EKS\nDescribeCluster · ListAddons · DescribeAddon\naccess entry 그룹 physical-ai:web", 60, 80, parent="eks")
    p.box("k8s", "Kubernetes 리소스 (raw REST)\n• nodes: 목록 · cordon JSON-Patch(uid/resourceVersion test) · SelfSubjectAccessReview\n• 노드 복구: label sagemaker.amazonaws.com/node-health-status=UnschedulablePendingReboot|Replacement\n• jobs/pods/events/namespaces (시스템 네임스페이스 차단) · Job 삭제(Background)\n• Kueue CRD kueue.x-k8s.io/v1beta1: clusterqueues · localqueues · resourceflavors · workloadpriorityclasses · workloads\n• JobSet jobset.x-k8s.io/v1alpha2 · Grafana 는 services/proxy (관리자)",
          380, 60, 740, 200, parent="eks")
    p.n("nodes", "container_2", "노드 hyperpod-i-…\ncpu-c5-4x ×2 · gpu-g5-8x ×1", 100, 380, parent="eks")
    p.n("kueue", "container_2", "Kueue ClusterQueue / LocalQueue\nhyperpod-ns-team-a-localqueue", 460, 380, parent="eks")
    p.n("jobs", "container_2", "Jobs / Pods / Events\n(wf-<id>-* 라벨)", 820, 380, parent="eks")
    p.n("fsx", "fsx_for_lustre", "FSx for Lustre\nDescribeFileSystems · DescribeDataRepositoryAssociations\nCreateDataRepositoryTask EXPORT_TO_REPOSITORY", 560, 760, parent="cloud")
    p.n("ddb", "dynamodb", "DynamoDB\nSCALING#<backend>#<cluster>/POLICY#·PLAN#·ACTIVE\nSYS/LEASE#SCALE", 120, 1000, parent="cloud")
    p.n("amp", "managed_service_for_prometheus", "Amazon Managed Service for Prometheus\nws-25f09b6a-… /api/v1/query · query_range\nSigV4 service=aps · 허용된 PromQL 빌더만", 1000, 1000, parent="cloud")
    p.n("cw", "cloudwatch", "CloudWatch Logs\n/aws/sagemaker/Clusters/<cluster>\n(리소스 스트립 링크)", 560, 1000, parent="cloud")
    p.box("scale", "노드 수 변경(관리자) 흐름: snapshot(DescribeCluster + 노드/Pod + DynamoDB 활동 스캔 + SSAR) → 차단 사유(pods_active · workflows_active · sessions_active · policy_missing …)\n→ 정책 저장(min/baseline/idle) → 계획 생성(5분 TTL) → 실행: 임대 획득 → cordon → 재검사 → BatchDeleteClusterNodes/UpdateCluster → 관찰(reconcile) SUCCEEDED/PARTIAL/FAILED. 유휴 자동 축소는 기본 비활성(워커 60초).",
          1260, 800, 1160, 110, parent="cloud")
    p.box("metrics", "메트릭 탭: GPU(DCGM util/mem/power/temp) · 노드(node_exporter, 관리자) 또는 Pod(cAdvisor, 연구자 네임스페이스 강제) · Kueue(pending/admitted, 큐별 GPU/CPU) · 가용 자원. 비관리자 쿼리는 scopedMetric 으로 프로젝트 범위 재작성. 실행 상세 메트릭 탭도 같은 경로.",
          1260, 930, 1160, 80, parent="cloud")
    p.e("browser", "web", "")
    p.e("web", "hpapi", "컴퓨트: 클러스터·인스턴스 그룹·이벤트", exit=(0.5, 0), entry=(0, 0.5))
    p.e("web", "quota", "대기열·할당량 (관리자 생성/삭제)", dashed=True, exit=(0.75, 0), entry=(0.5, 1))
    p.e("hpapi", "ec2", "인스턴스 타입 사양", dashed=True, exit=(1, 0.75), entry=(0, 0.5))
    p.e("web", "eksapi", "", exit=(1, 0.25), entry=(0, 0.5))
    p.e("eksapi", "k8s", "endpoint · CA", dashed=True)
    p.e("k8s", "nodes", "", dashed=True, exit=(0.15, 1), entry=(0.5, 0))
    p.e("k8s", "kueue", "", dashed=True, exit=(0.5, 1), entry=(0.5, 0))
    p.e("k8s", "jobs", "", dashed=True, exit=(0.85, 1), entry=(0.5, 0))
    p.e("hpapi", "nodes", "인스턴스 그룹 → 노드", dashed=True, exit=(1, 0.25), entry=(0, 0.5))
    p.e("web", "fsx", "FSx 카드 · 지금 내보내기", exit=(1, 0.75), entry=(0, 0.5))
    p.e("web", "ddb", "스케일 정책·계획·임대", exit=(0.5, 1), entry=(0.5, 0))
    p.e("web", "amp", "POST /api/metrics/query (≤12 쿼리 배치)", exit=(1, 1), entry=(0, 0.25))
    p.e("nodes", "amp", "DCGM · node_exporter · kube-state-metrics\n(observability add-on remote write)", dashed=True, exit=(0.5, 1), entry=(0.5, 0))
    return p


def page_storage_usage() -> Page:
    p = Page("p07", "07 파일·사용량·비용", "파일(S3 · FSx) · 사용량·비용 · 홈 비용 카드",
             "S3 브라우저(presigned GET/PUT · DeleteObjects) · FSx DRA 작업 · task ledger 기반 CPU/GPU 시간 · Cost Explorer(관리자)")
    p.n("browser", "client", "브라우저\n파일 / 사용량·비용 / 홈", 60, 520)
    p.g("cloud", "cloud", "AWS", 300, 110, 2160, 1200)
    p.n("web", "fargate", "web API\n/api/s3 · /api/s3/presign · /api/fsx · /api/fsx/tasks\n/api/usage · /api/cost", 120, 520, parent="cloud")
    p.g("s3g", "generic", "허용 목록 버킷 (bucket allow-list · 비관리자는 projects/<p>/ 접두사 강제)", 500, 60, 960, 360, parent="cloud")
    p.n("s3a", "s3", "dashboard artifacts\n(스냅샷 · 업로드 · scratch)", 60, 100, parent="s3g")
    p.n("s3b", "s3", "hyperpod-eks-data\n(FSx DRA · datasets/ · checkpoints/)", 340, 100, parent="s3g")
    p.n("s3c", "s3", "groot-sm-artifacts\n(SageMaker 산출물)", 620, 100, parent="s3g")
    p.n("s3d", "s3", "hyperpod-data (Slurm)", 840, 100, parent="s3g")
    p.n("fsx", "fsx_for_lustre", "FSx for Lustre (EKS · Slurm 2개)\nDescribeFileSystems · DescribeDataRepositoryAssociations\nDescribeDataRepositoryTasks · CreateDataRepositoryTask\nEXPORT_TO_REPOSITORY / IMPORT_METADATA_FROM_REPOSITORY", 1600, 160, parent="cloud")
    p.n("ddb", "dynamodb", "DynamoDB\nWF# task ledger · RUNTIME# receipts", 640, 620, parent="cloud")
    p.n("ce", "cost_explorer", "Cost Explorer (us-east-1 엔드포인트)\nGetCostAndUsage DAILY · UnblendedCost\nGROUP BY SERVICE · 최근 30일 (1h 캐시)", 1600, 620, parent="cloud")
    p.box("s3ops", "S3 브라우저 동작: ListObjectsV2(Delimiter '/', MaxKeys 200) · 다운로드 presigned GET 900초 · 업로드 presigned PUT 3600초(연구자, projects/<p>/scratch/)\n삭제 DeleteObjects ≤1000 (관리자) · 각 접두사는 FSx 미러 경로 /fsx/<prefix> 를 함께 표시",
          500, 440, 960, 80, parent="cloud")
    p.box("usage", "사용량 계산: task ledger·runtime 기록 기반 실행별 요청 CPU/GPU 시간(replica 시간 × 요청 자원). 타이밍·리소스 기록이 없으면 null(추정하지 않음).\n실제 이용률·청구액 아님 · 단가/비용 산출 없음. 홈/관리 패널의 '계정 전체 비용' 은 Cost Explorer 값(관리자 전용)으로, 대시보드 외 서비스(EC2 · Bedrock 등) 포함.",
          500, 860, 1560, 110, parent="cloud")
    p.e("browser", "web", "")
    p.e("browser", "s3a", "presigned GET/PUT 직접 전송", exit=(0.5, 0), entry=(0, 0.25), color="#7AA116")
    p.e("web", "s3a", "List · Head · presign · Delete", exit=(1, 0.25), entry=(0, 0.75))
    p.e("web", "s3b", "", exit=(0.75, 0), entry=(0.5, 1), dashed=True)
    p.e("s3b", "fsx", "DRA", dashed=True, exit=(1, 0.5), entry=(0, 0.25))
    p.e("web", "fsx", "FSx 상태 · DRA 작업 생성(연구자)", exit=(1, 0.5), entry=(0, 0.75))
    p.e("web", "ddb", "task ledger 조회", exit=(1, 0.75), entry=(0, 0.5))
    p.e("web", "ce", "관리자만", dashed=True, exit=(0.5, 1), entry=(0, 0.5))
    return p


def page_settings() -> Page:
    p = Page("p08", "08 설정(프로젝트·이미지·빌드·웹훅·엣지·백엔드)", "설정: 프로젝트·구성원 · 이미지·실행 환경 · 환경 빌드 · 자동화·웹훅 · 디바이스·배포 · 백엔드 연결",
             "DynamoDB 가 모든 원장 · ECR digest 고정 · CodeBuild 소스 빌드 · SSM SecureString · HTTPS HMAC 웹훅 · IoT/Greengrass 배포 · EKS 백엔드 프로브")
    p.n("browser", "client", "브라우저\n(설정 그룹 화면)", 60, 620)
    p.g("cloud", "cloud", "AWS", 300, 110, 2160, 1380)
    p.n("web", "fargate", "web API\n/api/projects · /api/image-profiles · /api/execution-profiles\n/api/builds · /api/webhooks · /api/edge · /api/backends", 120, 620, parent="cloud")
    p.n("ddb", "dynamodb", "DynamoDB\nPROJECT#<id> · IMAGE_PROFILE(_REV)# · EXECUTION_PROFILE#\nSOURCE# · BUILD# · WEBHOOK# · DELIVERY# · DEVICE# · EDGE_OP# · BACKEND#", 520, 620, parent="cloud")
    # images & builds lane (top)
    p.g("img", "generic", "이미지·실행 환경 / 환경 빌드", 460, 60, 1000, 530, parent="cloud")
    p.n("ecr", "ecr", "ECR (같은 계정 private 만)\nDescribeImages · GetAuthorizationToken\nRegistry v2 manifest/config → @sha256 digest\namd64 확인", 60, 80, parent="img")
    p.n("cb", "codebuild", "CodeBuild physical-ai-source-<proj>\nStartBuild(idempotencyToken) · BatchGetBuilds\nStopBuild · 고정 buildspec (zip SHA 검증 → docker build → push)", 400, 80, parent="img")
    p.n("s3src", "s3", "S3 소스 스냅샷\n(zip · VersionId + SHA-256)", 740, 80, parent="img")
    p.n("cw", "cloudwatch", "CloudWatch Logs\nGetLogEvents (빌드 로그 tail)", 740, 300, parent="img")
    p.n("ec2", "ec2", "EC2 DescribeInstanceTypes\n(프로필 최소 vCPU/GPU 검사)", 400, 300, parent="img")
    p.box("imgflow", "승인 흐름: 소스 등록(S3/Git) → 빌드 → ECR digest → 이미지 프로필 '검사하고 승인 버전 저장'(관리자, 리비전 기록) → 워크플로 preflight 가 태스크별 정확히 1개 활성 프로필 요구,\n큐 대기 중 승인 철회되면 launch 시 image_approval_changed 로 차단. 실행 프로필(host 권한)은 전용 노드 라벨/taint 와 승인 태스크 해시를 검사하는 별도 관리자 신뢰 경계.",
          60, 450, 920, 60, parent="img")
    # webhooks & credentials lane
    p.n("ssm", "parameter_store", "SSM Parameter Store\n/physical-ai/projects/<p>/webhooks/<hook> (endpoint+secret)\n/physical-ai/projects/<p>/… 자격증명", 1600, 120, parent="cloud")
    p.n("hook", "internet", "웹훅 수신 endpoint (HTTPS 443만)\nx-pai-event-id · x-pai-timestamp\nx-pai-signature v1=HMAC-SHA256(ts.eventId.body)\n사설 IP 거부 · 리다이렉트 없음 · 10초", 1950, 120, parent="cloud")
    p.n("ctrl", "fargate", "controller 워커\ndeliverWebhooks (5초, 8회/24h 백오프)\nreconcileSourceBuilds · refreshBackendChecks", 1600, 420, parent="cloud")
    # edge lane
    p.g("edge", "generic", "디바이스·배포 (엣지)", 1000, 760, 1120, 300, parent="cloud")
    p.n("iot", "iot_core", "AWS IoT Core\nDescribeThingGroup · ListThingsInThingGroup\nDescribeThing", 60, 80, parent="edge")
    p.n("gg", "greengrass", "IoT Greengrass v2\nGetCoreDevice · ListInstalledComponents\nGetComponent · CreateDeployment(:thing/ 만, ROLLBACK)", 400, 80, parent="edge")
    p.n("s3ev", "s3", "S3 artifacts\nprojects/<p>/edge/<device>/operations/<op>/\nbenchmark.json · readiness.json", 760, 80, parent="edge")
    p.box("edgeflow", "장치 등록(project-admin) → 배포 준비(모델 qualityApproval 필수) → lease 획득(HIL 독점, TTL) → 제출 → Greengrass 배포 → 벤치마크 수집 → 롤백(이전 desired 구성). 물리 장치 검증은 별개.",
          60, 230, 1000, 50, parent="edge")
    # projects & backends lane (bottom-left)
    p.g("be", "generic", "프로젝트·구성원 / 백엔드 연결", 100, 900, 860, 420, parent="cloud")
    p.n("eks", "eks", "EKS DescribeCluster\n(ACTIVE · private endpoint · VPC 일치)", 60, 80, parent="be")
    p.box("probe", "백엔드 프로브: /version · JobSet API · SelfSubjectAccessReview(nodes·namespaces·PV·kueue·jobsets)\n네임스페이스별 LocalQueue · fsx-pvc PV(fsx.csi.aws.com, volumeHandle=fsxId)\n프로필은 EKS_BACKENDS_JSON 환경변수만 · HTTP 로 endpoint/role 설정 불가 · STS AssumeRole 없음",
          320, 60, 500, 120, parent="be")
    p.box("proj", "프로젝트: id · 이름 · 네임스페이스(hyperpod-ns-*) · backendId → 큐 <ns>-localqueue 존재 확인 후 생성(관리자)\n구성원 역할 viewer/researcher/project-admin 은 Cognito sub 기준으로 DynamoDB 저장 · 헤더 x-pai-project / 쿠키 pai-project 로 선택",
          60, 230, 760, 100, parent="be")
    p.e("browser", "web", "")
    p.e("web", "ddb", "모든 레코드 · 리비전 · 임대")
    p.e("web", "ecr", "이미지 검사 · seed 후보", exit=(0.5, 0), entry=(0, 0.5))
    p.e("web", "cb", "StartBuild (2 슬롯/프로젝트)", dashed=True, exit=(0.75, 0), entry=(0, 0.75))
    p.e("s3src", "cb", "source", dashed=True)
    p.e("cb", "ecr", "push pai-source-<buildId>", dashed=True, exit=(0, 0.25), entry=(1, 0.25))
    p.e("cb", "cw", "", dashed=True, exit=(1, 0.75), entry=(0, 0.5))
    p.e("web", "ec2", "", dashed=True, exit=(0.85, 0), entry=(0, 0.5))
    p.e("web", "ssm", "웹훅 secret · 자격증명 SecureString", exit=(1, 0.25), entry=(0, 0.5))
    p.e("ctrl", "ssm", "GetParameter(version)", dashed=True, exit=(0.5, 0), entry=(0.5, 1))
    p.e("ctrl", "hook", "서명된 POST", exit=(1, 0.25), entry=(0.5, 1))
    p.e("ctrl", "ddb", "전달 상태 · 빌드 상태 · 백엔드 체크", exit=(0, 0.5), entry=(1, 0.25), color="#8C4FFF")
    p.e("ctrl", "cb", "BatchGetBuilds → ECR digest 검증", dashed=True, exit=(0, 0.25), entry=(1, 0.5), color="#8C4FFF")
    p.e("web", "iot", "장치 조회", exit=(1, 0.75), entry=(0, 0.25))
    p.e("web", "gg", "배포 제출 · 롤백", dashed=True, exit=(1, 1), entry=(0, 0.75))
    p.e("gg", "s3ev", "증거 읽기 (VersionId)", dashed=True)
    p.e("web", "eks", "백엔드 등록 · 연결 확인", exit=(0.5, 1), entry=(0.5, 0))
    p.e("eks", "probe", "", dashed=True)
    return p


pages = [page_overview(), page_auth(), page_workflows(), page_datasets(), page_models(),
         page_sessions(), page_cluster(), page_storage_usage(), page_settings()]


def main() -> None:
    xml = '<mxfile host="Electron" modified="2026-09-18T00:00:00.000Z" agent="gen_diagrams.py" version="24.7.17" type="device">'
    xml += "".join(render_page(p) for p in pages)
    xml += "</mxfile>"
    out = "physical-ai-dashboard-features.drawio"
    with open(out, "w", encoding="utf-8") as fh:
        fh.write(xml)
    print(f"wrote {out} with {len(pages)} pages")
    with open("pages.txt", "w", encoding="utf-8") as fh:
        for i, p in enumerate(pages):
            fh.write(f"{i}\t{p.name}\n")


if __name__ == "__main__":
    main()
