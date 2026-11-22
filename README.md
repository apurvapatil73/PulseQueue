# PulseQueue

> **Distributed Job Processing and Workflow Management Platform**

PulseQueue is a modern, high-throughput distributed job processing and workflow orchestration platform built with TypeScript, Node.js, Redis, BullMQ, and PostgreSQL. It delivers resilient background task management, workflow execution graphs, and real-time observability.

---

## Table of Contents

- [Project Overview](#project-overview)
- [Technology Stack](#technology-stack)
- [Prerequisites](#prerequisites)
- [Project Structure](#project-structure)
- [Environment Configuration](#environment-configuration)
- [Installation Instructions](#installation-instructions)
- [Docker Infrastructure](#docker-infrastructure)
  - [Starting Infrastructure](#starting-infrastructure)
  - [Stopping Infrastructure](#stopping-infrastructure)
  - [Inspecting Logs & Health](#inspecting-logs--health)
- [Development Scripts](#development-scripts)
- [Architecture](#architecture)
- [License](#license)

---

## Project Overview

Modern systems require reliable decoupling between user-facing HTTP requests and long-running or resource-intensive tasks. PulseQueue bridges this gap by providing:

- **Asynchronous Queue Management:** High-performance priority queues, delayed jobs, retries with exponential backoff, and dead-letter queue (DLQ) handling.
- **Workflow Orchestration:** Multi-step job pipelines and directed acyclic graph (DAG) execution.
- **Telemetry & Monitoring:** Live queue statistics, worker health monitoring, and audit trails.
- **Strict Typing:** End-to-end TypeScript monorepo architecture ensuring contract consistency across frontend, backend, and background workers.

---

## Technology Stack

- **Runtime & Language:** [Node.js](https://nodejs.org/) (v20+ LTS / v22+ LTS), [TypeScript](https://www.typescriptlang.org/) (v5.7+)
- **Package & Workspace Manager:** [npm Workspaces](https://docs.npmjs.com/cli/using-npm/workspaces)
- **Queue Engine:** [Redis](https://redis.io/) (v7.x) & [BullMQ](https://bullmq.io/) (Planned)
- **Primary Database:** [PostgreSQL](https://www.postgresql.org/) (v16.x)
- **Infrastructure Orchestration:** [Docker Compose](https://docs.docker.com/compose/)
- **Code Quality & Tooling:** [ESLint](https://eslint.org/) (v9 Flat Config), [Prettier](https://prettier.io/)

---

## Prerequisites

Before running or developing on PulseQueue, ensure the following tools are installed on your host machine:

| Prerequisite                | Minimum Version                         | Description                                |
| --------------------------- | --------------------------------------- | ------------------------------------------ |
| **Node.js**                 | `>= 20.0.0` (LTS recommended)           | JavaScript runtime environment             |
| **npm**                     | `>= 10.0.0`                             | Package manager supporting npm workspaces  |
| **Git**                     | `>= 2.40.0`                             | Source control management                  |
| **Docker Engine & Compose** | Docker `>= 24.0.0`, Compose `>= 2.20.0` | Container runtime for PostgreSQL and Redis |

> **Note for Windows Users:** Install [Docker Desktop for Windows](https://docs.docker.com/desktop/setup/install/windows-install/) with WSL 2 integration enabled.

---

## Project Structure

PulseQueue is organized as a clean monorepo managed with npm workspaces:

```text
PulseQueue/
├── .github/
│   └── workflows/
│       └── ci.yml               # GitHub Actions CI pipeline (lint, typecheck, build)
├── apps/
│   ├── frontend/                # Web Dashboard application (React / SPA)
│   │   ├── src/                 # Frontend source files
│   │   ├── package.json         # Workspace package configuration
│   │   └── tsconfig.json        # TypeScript configuration
│   ├── backend/                 # Core API & Ingestion Service (Node.js / Express)
│   │   ├── src/                 # Backend source files
│   │   ├── package.json         # Workspace package configuration
│   │   └── tsconfig.json        # TypeScript configuration
│   └── worker/                  # Background Worker Consumer (BullMQ processors)
│       ├── src/                 # Worker source files
│       ├── package.json         # Workspace package configuration
│       └── tsconfig.json        # TypeScript configuration
├── packages/
│   └── shared/                  # Common domain contracts, DTOs, and enums
│       ├── src/                 # Shared source files
│       ├── package.json         # Workspace package configuration
│       └── tsconfig.json        # TypeScript configuration
├── infrastructure/
│   └── docker/                  # Dockerfiles and infrastructure configs
│       └── README.md
├── docs/
│   └── architecture/
│       └── overview.md          # Comprehensive architecture & Mermaid diagram
├── .env.example                 # Documented environment variable template
├── .gitignore                   # Version control ignore rules
├── .prettierrc                  # Prettier code formatting rules
├── .prettierignore              # Prettier ignore patterns
├── eslint.config.mjs            # ESLint 9 Flat Config
├── docker-compose.yml           # PostgreSQL 16 & Redis 7 container specifications
├── tsconfig.base.json           # Shared base compiler options
├── tsconfig.json                # Monorepo composite project references
├── package.json                 # Root monorepo configuration & scripts
└── README.md                    # Project documentation
```

---

## Environment Configuration

1. Copy the example environment file:

   ```bash
   cp .env.example .env
   ```

   _(On Windows PowerShell: `Copy-Item .env.example .env`)_

2. Review and configure the variables in `.env`:
   - `DATABASE_URL`: Connection string for PostgreSQL.
   - `POSTGRES_USER`: PostgreSQL username (default: `pulsequeue`).
   - `POSTGRES_PASSWORD`: PostgreSQL password (default: `pulsequeue_secure_password_replace_in_prod`).
   - `POSTGRES_DB`: Target database name (default: `pulsequeue`).
   - `REDIS_URL`: Connection string for Redis (default: `redis://localhost:6379`).
   - `JWT_SECRET`: Secret key for token signing.
   - `PORT`: Backend server port (default: `3000`).
   - `NODE_ENV`: Application environment (`development`, `production`, `test`).

> **Security Warning:** Never commit `.env` or plain-text secrets to version control. Keep `.env` in `.gitignore`.

---

## Installation Instructions

1. Clone the repository:

   ```bash
   git clone <repository-url>
   cd PulseQueue
   ```

2. Install all monorepo dependencies across all workspaces:

   ```bash
   npm install
   ```

3. Validate TypeScript type configurations:

   ```bash
   npm run typecheck
   ```

4. Build all packages and applications:
   ```bash
   npm run build
   ```

---

## Docker Infrastructure

PulseQueue uses Docker Compose to provision local infrastructure services:

- **PostgreSQL 16**: Relational storage on port `5432` with automated health checks and persistent volume `pulsequeue_postgres_data`.
- **Redis 7**: In-memory broker on port `6379` with AOF persistence enabled and health checks.
- **Internal Network**: All containers communicate across the dedicated internal bridge network `pulsequeue-network`.

### Starting Infrastructure

Start the PostgreSQL and Redis containers in detached mode:

```bash
npm run docker:up
# Or directly with Docker Compose:
docker compose up -d
```

### Checking Container Status

Verify that containers are running and healthy:

```bash
docker compose ps
```

Expected status:

- `pulsequeue-postgres`: `Up` (healthy)
- `pulsequeue-redis`: `Up` (healthy)

### Stopping Infrastructure

Stop running containers while preserving data volumes:

```bash
npm run docker:down
# Or directly:
docker compose down
```

### Stopping Infrastructure and Removing Volumes

To stop containers and completely purge database and Redis volumes:

```bash
npm run docker:down:volumes
# Or directly:
docker compose down -v
```

### Inspecting Logs & Health

Stream logs from all infrastructure services:

```bash
npm run docker:logs
# Or for a specific service:
docker compose logs -f postgres
docker compose logs -f redis
```

Manual health probes:

```bash
# Verify Redis responds to PING
docker compose exec redis redis-cli ping
# Expected output: PONG

# Verify PostgreSQL readiness
docker compose exec postgres pg_isready -U pulsequeue -d pulsequeue
# Expected output: pulsequeue:5432 - accepting connections
```

---

## Development Scripts

The root `package.json` includes convenience scripts across the workspaces:

| Command                       | Action                                                               |
| ----------------------------- | -------------------------------------------------------------------- |
| `npm run build`               | Compiles all TypeScript projects using project references (`tsc -b`) |
| `npm run typecheck`           | Type-checks all workspaces without emitting output                   |
| `npm run lint`                | Lints all TypeScript and JavaScript files with ESLint                |
| `npm run lint:fix`            | Automatically fixes auto-fixable ESLint warnings and errors          |
| `npm run format`              | Formats all source files with Prettier                               |
| `npm run format:check`        | Checks code formatting with Prettier without modifying files         |
| `npm run docker:up`           | Starts PostgreSQL and Redis infrastructure containers                |
| `npm run docker:down`         | Stops infrastructure containers                                      |
| `npm run docker:down:volumes` | Stops infrastructure containers and deletes persistent data volumes  |
| `npm run docker:logs`         | Streams live logs from infrastructure containers                     |
| `npm run clean`               | Cleans build artifacts (`dist/` and `*.tsbuildinfo`)                 |

---

## Architecture

For an in-depth breakdown of system design, component responsibilities, and data flow diagrams, refer to [Architecture Overview](docs/architecture/overview.md).

---

## License

MIT
