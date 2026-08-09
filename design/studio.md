# Silo Studio

Silo Studio is a local, agent-native environment for building applications on top of Silo.

A Studio project is a normal Git repository containing a Waku web application. Waku uses Vite as its development and build foundation, while providing the server-component runtime needed for local Silo access. Studio brings together the application, an embedded coding agent, Silo-backed structured data, and Git history in one desktop interface.

## Core experience

The main Studio window has two primary surfaces:

```text
┌───────────────────────────────────────────────────────────┐
│ Silo Studio                                               │
├─────────────────┬─────────────────────────────────────────┤
│                 │                                         │
│  Agent          │                                         │
│                 │            Application                  │
│  Pi             │                                         │
│  conversation   │         Waku + WebView                  │
│                 │                                         │
│                 │                                         │
└─────────────────┴─────────────────────────────────────────┘
```

The agent sidebar is toggleable, allowing the running application to occupy the full window when desired.

The basic interaction is simple:

> Tell the agent what you want changed, and watch the application update.

## Application

The application is an ordinary Waku project stored directly in the repository. Waku provides file-based routing and React server/client components while using Vite for development and builds.

Studio runs the local Waku development server and displays the application inside a Chromium WebView using `webview_cef`.

Studio is a desktop Flutter host. Flutter starts and supervises two separate Node.js sidecars: one for Waku and one for Pi. The WebView only renders Waku's local HTTP endpoint, while the agent sidebar communicates with Pi over its RPC stream. This keeps Waku server components and the local Silo integration in Node while Flutter remains the host and UI process.

The runtime flow is:

```text
Flutter desktop host
  ├─ starts/supervises ─► Node.js sidecar (Waku)
  │                          │ serves Waku on 127.0.0.1:<port>
  │                          ▼
  │                      webview_cef
  │
  └─ starts/supervises ─► Node.js sidecar (Pi RPC)
                             │ JSONL over stdin/stdout
                             ▼
                         agent sidebar
```

Pi must not run inside Waku's Node.js process. Studio uses the same bundled Node.js runtime where practical, but keeps the processes separate. This protects long-lived Pi sessions from Waku's development and HMR lifecycle, isolates Pi's full filesystem and shell capabilities from Waku request handling, and prevents dependency, crash, and resource contention from coupling the two runtimes.

At startup, the host selects an available loopback port, launches a bundled and platform-matched Node.js runtime with the project repository as its working directory, starts the Waku sidecar, and starts the Pi sidecar in `--mode rpc` with the same working directory. It waits for Waku's HTTP readiness check, attaches to Pi's JSONL stream, and then navigates the WebView to the Waku endpoint. The host captures output from both sidecars, detects crashes, can restart them independently, and terminates them when the project or Studio window closes. The Waku sidecar must bind only to loopback; Pi should use stdin/stdout or local IPC rather than the Waku HTTP endpoint. If Pi ever needs a network transport, it must be loopback-only and authenticated.

The sidecars share the project repository and local Silo database but do not share process memory. Agent and application mutations continue to use Silo's supported mutation boundaries and the same invalidation path.

Packaged Studio builds should ship the compatible Node.js runtime, the Waku project dependencies, and the Pi runtime/package rather than assuming that Node.js is installed on the user's machine. Development uses Waku's dev server and HMR; a packaged application should serve a built Waku application instead of relying on the development server.

This sidecar model targets Flutter desktop builds for macOS, Windows, and Linux. Flutter Web and mobile platforms cannot generally launch an arbitrary Node.js child process, so they would require an embedded JavaScript runtime or a different server boundary.

A project might look like:

```text
project/
├── src/
├── public/
├── package.json
├── waku.config.ts
├── AGENTS.md
└── ...
```

Changes to the source are reflected in the WebView through Waku and Vite's normal development workflow and HMR. Data changes use the Silo invalidation path described below.

The source code in the repository is the application itself.

### Project foundation

Each new Studio project initially starts from Waku's [`fs-router/basic`](https://github.com/wakujs/waku-examples/tree/main/fs-router/basic) example. This provides a small, conventional baseline while Studio's own project template develops. The upstream example is a starting point, not a permanent dependency on its exact structure.

Studio's eventual project template will establish these defaults:

- Silo access is server-only.
- Mantine is the default UI kit.
- Application-authored styles use CSS Modules.
- The project includes agent instructions for the server/client boundary and the supported Silo workflows.

The upstream starter currently uses Tailwind. The Studio template should replace it rather than maintain two competing styling systems.

### UI foundation

Mantine gives the agent a broad set of typed, accessible UI primitives for building interfaces quickly and consistently. A server page can fetch Silo data and pass serializable values to Mantine components, while interactive controls remain in client components.

Mantine components are client components that render on both the server and client. Silo modules must remain above that boundary; client components must not open SQLite or import the Silo integration directly. Mantine's compound-component syntax may require a small client wrapper or its server-compatible flat component exports.

Application-authored styles use `*.module.css` files. Required library styles, such as Mantine's root stylesheet, are loaded once at the application root; Studio avoids custom global CSS where CSS Modules are sufficient.

## Agent

Studio embeds Pi as its coding-agent harness.

Pi operates directly inside the project repository. It can:

- Read and edit source files.
- Run commands.
- Install dependencies.
- Run tests and builds.
- Use Git.
- Understand and operate Silo.

This lets the user work at the level of intent:

```text
"Add an authors page."

"Show each author's recent posts."

"Make this sidebar narrower."

"Add a status field to articles."
```

The agent translates those requests into changes to the application and its underlying data model.

## Silo

Silo provides the application's durable structured data layer.

It supplies concepts such as:

- SQLite tables.
- Semantic types.
- Semantic relations.
- Constraints.
- Policies.
- Saved queries.
- Mutation journal.

### Server-only data access

Silo reads occur in Waku server components or server-only modules called by them. Silo writes occur in server actions or API handlers through Silo's supported mutation boundaries. Client components receive only the serializable data needed for their UI and never open SQLite or import the Silo integration.

Pages and layouts that read current Silo data must render dynamically. Waku's static rendering is useful for content that is fixed at build time, but it would otherwise bake a database-backed view into a build artifact.

The Waku application accesses Silo through a local integration layer:

```text
Waku server components/actions
              │
              ▼
      local Silo integration
              │
              ▼
           Silo / SQLite
```

The mutation journal is bounded local invalidation metadata, not audit history or a replay log. Studio observes it through the local integration and asks the running application to refresh the affected route or RSC content. If the journal window is unavailable or an unknown change is detected, the application falls back to a broader refresh.

Because the agent also knows how to use Silo, it can work across both application code and structured data. Agent mutations and application mutations use the same invalidation path.

## Git

Every Studio project is a Git repository.

Git provides the durable history of the application and gives the agent a clear workflow for managing changes.

Studio exposes that history in an approachable form:

```text
History

● Add author profile page
│
● Add post filtering
│
● Create initial dashboard
│
● Initial project
```

Users can inspect previous changes and restore earlier versions of the application.

The repository contains the project's source code, configuration, agent instructions, and other repository-owned files.

## GitHub

Studio includes GitHub authentication so a project repository can be backed up to GitHub.

The local repository remains the working project, while GitHub provides remote backup and portability.

## Architecture

At a high level:

```text
                    Silo Studio
                         │
        ┌────────────────┼────────────────┐
        │                │                │
        ▼                ▼                ▼
       Pi             WebView            Git
    coding agent    Waku application    history
        │                │
        └────────┬───────┘
                 ▼
              repository
                 │
                 ▼
                Silo
                 │
                 ▼
               SQLite
```

Each piece has a clear responsibility:

**The repository is the application.**

**Silo is the structured data layer.**

**Pi is the programmer.**

**The WebView is the live application.**

**Git is the application's history.**

## Design document scope

This file is the durable overview of Silo Studio: its product concept, primary surfaces, and responsibility boundaries. It should remain readable as a summary rather than becoming the complete implementation record.

Split detailed designs into `design/studio/<concern>.md` when a concern gains its own lifecycle, protocol, or set of implementation decisions. The likely boundaries are the Waku/WebView runtime, Silo data access and invalidation, and the project template/UI conventions. The [first-version plan](studio/first-version.md) records the ordered work from repository bootstrap through the first desktop release. Keep this file as the overview and link to those documents from here once they exist. Do not split merely because a technology has a few configuration details, and do not create technology-specific documents that do not represent a Studio-owned boundary.

## Vision

Silo Studio is a local environment where a user and an agent collaboratively build software around durable structured data.

The user describes what they want.

The agent edits the project.

The application changes live.

Silo provides the data underneath it.

Git remembers how the application got there.
