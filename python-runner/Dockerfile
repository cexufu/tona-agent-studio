FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
RUN groupadd --gid 10001 tona && useradd --uid 10001 --gid tona --no-create-home tona
WORKDIR /job
COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt && rm /tmp/requirements.txt
USER 10001:10001
CMD ["python", "-I", "/job/main.py"]