# Build context: repository root (see app/template.yaml DockerContext).
# 3.12 base = Amazon Linux 2023 (glibc new enough for ortools aarch64 wheels)
FROM public.ecr.aws/lambda/python:3.12-arm64

RUN pip install --no-cache-dir "pydantic>=2" numpy ortools
COPY pipeline/strawlink_planner ${LAMBDA_TASK_ROOT}/strawlink_planner
COPY app/backend/planner_fn/app.py ${LAMBDA_TASK_ROOT}/app.py

CMD ["app.handler"]
