# syntax=docker/dockerfile:1
FROM python:3.12-slim-bookworm@sha256:782412e85d0f0984994c290652577d4018aff08145c85b262bb63dc0c7522254
ARG TARGETARCH
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HOME=/workspace XDG_CONFIG_HOME=/workspace/.config XDG_DATA_HOME=/workspace/.local/share \
    XDG_CACHE_HOME=/workspace/.cache AWS_EC2_METADATA_DISABLED=true
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git libatomic1 tini \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1000 researcher && useradd --uid 1000 --gid 1000 --home-dir /workspace --shell /bin/bash researcher
COPY requirements.txt /opt/pai/requirements.txt
RUN pip install --no-cache-dir -r /opt/pai/requirements.txt
RUN set -eu; arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
    case "$arch" in \
      amd64) checksum=9303165b7fd43532091922f77e2f119ff2fa109c6b6f1c3c966fb02f3d6d9c8b ;; \
      arm64) checksum=0fba760298fe06480d940e218f0873a645ba1e7e3ac4b527059af82d85a90462 ;; \
      *) exit 1 ;; \
    esac; \
    curl --fail --location --proto '=https' --tlsv1.2 \
      "https://github.com/coder/code-server/releases/download/v4.137.0/code-server-4.137.0-linux-${arch}.tar.gz" -o /tmp/code-server.tar.gz; \
    echo "$checksum  /tmp/code-server.tar.gz" | sha256sum --check -; \
    mkdir -p /opt/code-server; tar -xzf /tmp/code-server.tar.gz -C /opt/code-server --strip-components=1; \
    ln -s /opt/code-server/bin/code-server /usr/local/bin/code-server; rm /tmp/code-server.tar.gz
COPY session.py prepare.py /opt/pai/
RUN mkdir -p /workspace && chown 1000:1000 /workspace
USER 1000:1000
WORKDIR /workspace
ENTRYPOINT ["/usr/bin/tini", "--", "python", "/opt/pai/session.py"]
CMD ["jupyter"]
