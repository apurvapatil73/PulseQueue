# PulseQueue Docker Infrastructure

This directory holds Docker-related configurations, custom Dockerfiles, and containerization scripts for the PulseQueue platform.

## Infrastructure Components

- **PostgreSQL 16**: Primary persistent relational datastore for jobs, workflows, execution logs, and user data.
- **Redis 7**: In-memory high-throughput data store backing BullMQ distributed queues, state synchronization, and pub/sub events.

## Directory Structure (Planned)

```text
infrastructure/docker/
├── README.md               # Infrastructure documentation
├── backend.Dockerfile      # Container definition for API service (future)
├── worker.Dockerfile       # Container definition for queue worker (future)
└── frontend.Dockerfile     # Container definition for web UI (future)
```

## Running Infrastructure

Refer to the root [docker-compose.yml](../../docker-compose.yml) and root `README.md` for commands to launch and manage services.
