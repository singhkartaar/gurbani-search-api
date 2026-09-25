# Deploying

The honest summary first: **cloud is expensive for this, because managed
container platforms bill for memory-seconds and egress, and this service is
small, steady and stateless.** You would be paying for elasticity you do not
need. A plain virtual machine is usually 3-10x cheaper for a service like this,
and the gap grows with traffic.

Verify current prices before committing -- they change, and I would rather you
check than trust a number in a document.

## What it needs

Node 22 or newer, one core, and:

| Configuration | Resident | On disk |
|---|---:|---:|
| One index, no translations (`INDEXES=pa-ssa`, `--core-only`) | **149 MB** | 83 MB |
| The default packs | measure it with `docker stats` | 265 MB |

Each further index costs about 18 MB of vectors. Indexes sharing a model share
its ONNX session, so a second Punjabi index is vectors only while the first
English one adds a whole model (~35 MB).

**A one-index deployment fits in 256 MB of RAM.** That is the number that decides
your bill.

There is no database server, no cache, no queue, no build step, and no state.
Nothing is written at runtime, so the container can be entirely read-only and
there is nothing to back up.

## A small VPS -- the default answer

Hetzner, Netcup, OVH, Contabo, DigitalOcean, Vultr, Linode. The smallest tier at
most of them is 1-2 vCPU and 2-4 GB for roughly **EUR 3-6 per month**, which is
many times what this needs. No cold starts, a predictable bill, generous or
unmetered egress, and `docker compose up` is the whole deployment.

```bash
git clone https://github.com/singhkartaar/gurbani-search-api && cd gurbani-search-api
npm ci && npm run fetch-data
docker compose up -d
```

`deploy/docker/` pairs it with Caddy for automatic TLS. `deploy/systemd/` runs it
without Docker at all -- `DynamicUser`, `ProtectSystem=strict`, `MemoryMax=512M`,
about twelve lines of install.

Pick a region near your readers. For a Punjabi-speaking audience that usually
means India or Singapore; Hetzner has no Indian region, so Singapore or an Indian
provider may serve better than the cheapest European box.

## Free, if you accept the terms

- **Oracle Cloud Always Free** gives ARM Ampere instances with far more RAM than
  this needs, free indefinitely. The catch is real: capacity is often unavailable
  in popular regions, and idle accounts have been reclaimed. Fine for a hobby
  deployment, not for something people depend on.
- **A machine you already own.** A Raspberry Pi 4 or 5, or an old laptop, plus a
  Cloudflare Tunnel for a public HTTPS URL with no open port and no static IP.
  Cost is the electricity. `onnxruntime-node` publishes arm64 builds, so a Pi
  works; expect free-text queries in the hundreds of milliseconds rather than
  tens. Everything else stays fast.

## Scale-to-zero platforms

**Fly.io**, **Google Cloud Run**, **Render**. These bill only while running,
which suits a service nobody uses at 3am. Three caveats, all of which bite here:

- **Cold starts are not small.** The process loads ~83 MB of vectors and an ONNX
  session before it can answer. Expect a few seconds on the first request after
  idle. `deploy/fly/fly.toml` sets `auto_stop_machines = "stop"` and accepts that
  trade deliberately.
- **Pick the memory tier deliberately.** One index fits in 256 MB. Choosing the
  1 GB machine out of caution can triple the bill for the same service.
- **The data has to get there.** This image is code only, so either bake the data
  in with your own Dockerfile layer, or attach a volume and fetch into it. On
  Cloud Run, where there is no useful writable mount, baking it in is the only
  practical option -- a ~600 MB image and a correspondingly slower cold start.
  Render's free tier has an ephemeral disk and sleeps after ~15 minutes idle,
  waking in up to a minute.

## Where not to bother

**Vercel, Netlify, Cloudflare Workers, Deno Deploy, Lambda zip deployments.** A
native `onnxruntime-node` addon plus 83-265 MB of local files does not fit a
serverless function -- Vercel's unzipped limit is 250 MB, Lambda's layer limit is
the same, and Workers cannot load native addons at all. Lambda container images
would technically work and would still bill you for memory-seconds.

## Operating it

**Health.** `/api/health` never requires credentials, precisely so it works as a
container health check. It reports which indexes loaded, which can do free text,
and which translations exist -- enough to tell a broken deploy from a deliberate
one.

**Trimming memory.** `INDEXES=pa-ssa` loads one index. The server logs each index
it skips and why, so the startup output tells you what a given configuration will
and will not do.

**Upgrading a data release.** Fetch into a new directory, point `ARTIFACTS_DIR`
at it, restart, keep the old one until you are happy. Do not upgrade in place:
`line_id` is row order, so a half-replaced index renders the wrong verse while
looking perfectly healthy.

**A password.** Set `APP_PASSWORD` and every route except `/api/health` requires
HTTP Basic with any username. There is no per-user auth and no rate limiting on
search -- put it behind a reverse proxy if you need either.

**Egress** is the only thing that costs real money at scale, and API responses
are kilobytes. The data packs are served by GitHub Releases, which charges
nothing for bandwidth.
