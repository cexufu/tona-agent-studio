# TONA Python Runner

This image is an optional, isolated compute worker for the code.python.run Tool.

Build:

    docker build -t tona-python-runner:0.1.0 python-runner

Run Agent Studio with:

    TONA_PYTHON_DOCKER_IMAGE=tona-python-runner:0.1.0 npm start

Runtime contract:

- user code is mounted read-only at /job/main.py;
- selected workspace artifacts are mounted read-only in /job/input;
- generated files must be written to /job/output;
- networking is disabled;
- the container root filesystem is read-only;
- Linux capabilities are dropped and no-new-privileges is enabled;
- CPU, memory, process count, duration and output volume are bounded by Runtime policy;
- each invocation uses a new container and is removed after completion.

Production web hosts that cannot start sibling Docker containers should configure
TONA_PYTHON_RUNNER_URL and optionally TONA_PYTHON_RUNNER_TOKEN for an external
isolation service implementing POST /v1/execute. Do not run Python directly in
the Agent Studio web process.