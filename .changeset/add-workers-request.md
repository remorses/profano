---
'profano': minor
---

Add `profano workers request <url>` to capture a V8 CPU profile of one fetch against a local Cloudflare Worker.

Start the Worker with `wrangler dev --local --inspector-port 9230`, then:

```bash
profano workers request http://127.0.0.1:8788/ --warm
profano ./req.cpuprofile --sort total
```

The command talks to the wrangler inspector, starts the V8 profiler, fetches the URL, and writes a `.cpuprofile`. It works for any Worker, not one specific app. Pass `--warm` to skip isolate boot in the sample. Production cannot emit a `.cpuprofile`; this is local only.

Also enable `profano completions install` for Tab completion.
