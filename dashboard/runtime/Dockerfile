# syntax=docker/dockerfile:1
ARG TARGETARCH=amd64
FROM --platform=$BUILDPLATFORM public.ecr.aws/docker/library/golang:1.25 AS build
ARG TARGETARCH
WORKDIR /src
COPY go.mod ./
COPY *.go ./
RUN test "$TARGETARCH" = amd64 || test "$TARGETARCH" = arm64
RUN CGO_ENABLED=0 GOOS=linux GOARCH=$TARGETARCH \
    go build -trimpath -ldflags="-s -w -buildid=" -o /out/runtime .

# BusyBox provides sh/cp/chmod for the initContainer copy command. The workload
# receives only /opt/pai/runtime, which has no runtime dependencies on this image.
FROM --platform=linux/${TARGETARCH} public.ecr.aws/docker/library/busybox:1.37
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build --chmod=0555 /out/runtime /opt/pai/runtime
CMD ["/opt/pai/runtime"]
