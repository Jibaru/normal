const run = async (command: string[]): Promise<void> => {
  const child = Bun.spawn(command, {
    cwd: import.meta.dir.replace(/\/scripts$/, ""),
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  if (exitCode !== 0) {
    console.error(stdout);
    console.error(stderr);
    throw new Error(`Command failed: ${command.join(" ")}`);
  }

  if (stdout.trim() !== "") {
    console.info(stdout.trim());
  }
};

await run(["tofu", "fmt", "-check", "-recursive", "infra"]);
await run([
  "tofu",
  "-chdir=infra/compute",
  "init",
  "-backend=false",
  "-input=false",
]);
await run(["tofu", "-chdir=infra/compute", "validate", "-no-color"]);
await run(["tofu", "-chdir=infra/compute", "test", "-no-color"]);
