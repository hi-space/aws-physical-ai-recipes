# Isolated communication-only harness. No AWS SDK, credentials, model or robot driver.
FROM python:3.11.13-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
COPY dashboard/edge/virtual_device.py /opt/edge/virtual_device.py
USER 1000:1000
WORKDIR /opt/edge
CMD ["python", "virtual_device.py", "--self-test"]
