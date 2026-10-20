# Nextly

A Things-style task manager for Windows, macOS and iOS. Tasks are organized by
**Today** and **Next** flags; deadlines are optional. Tasks support subtasks,
dependencies, block-based notes with attachments, and Gmail links.

- `wireframes.html`: low-fidelity wireframes for all three platforms
- `server/`: sync server (Node 24, no dependencies) and its Docker Compose file
- `capture/`: Gmail bookmarklet for Chrome and Safari

## Run the sync server

The host needs Docker and Tailscale. Copy `server/docker-compose.yml` and
`server/.env.example` to the host, then:

```bash
cp .env.example .env    # set NEXTLY_BIND (tailscale ip -4) and NEXTLY_TOKEN
docker compose up -d --build
```

Compose builds the image from the `server/` folder of this repo's `main` branch.
