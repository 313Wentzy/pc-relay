const button = document.getElementById("start"),
  output = document.getElementById("result"),
  download = document.getElementById("download");
let report = null;
const percentile = (values, q) =>
  [...values].sort((a, b) => a - b)[
    Math.max(0, Math.ceil(values.length * q) - 1)
  ] ?? null;
button.addEventListener("click", async () => {
  button.disabled = true;
  download.disabled = true;
  const samples = [];
  let failures = 0;
  try {
    // Warm connection excluded from results.
    await fetch("/ping?nonce=warmup", {
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    for (let i = 0; i < 30; i++) {
      const nonce = crypto.randomUUID(),
        start = performance.now();
      try {
        const response = await fetch("/ping?nonce=" + nonce, {
          cache: "no-store",
          signal: AbortSignal.timeout(5000),
        });
        const data = await response.json();
        if (!response.ok || data.nonce !== nonce) throw new Error();
        samples.push(performance.now() - start);
      } catch {
        failures++;
      }
      output.textContent = JSON.stringify(
        {
          completed: i + 1,
          samples: samples.length,
          failures,
          p50Ms: percentile(samples, 0.5),
          p99Ms: percentile(samples, 0.99),
        },
        null,
        2,
      );
      if (i < 29) await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    report = {
      recordedAt: new Date().toISOString(),
      endpoint: location.origin,
      measurement: "HTTP RTT; warm request excluded; no PC/media path",
      samplesMs: samples,
      failures,
      p50Ms: percentile(samples, 0.5),
      p99Ms: percentile(samples, 0.99),
    };
    output.textContent = JSON.stringify(report, null, 2);
    download.disabled = false;
  } finally {
    button.disabled = false;
  }
});
download.addEventListener("click", () => {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = "relay-rtt.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
