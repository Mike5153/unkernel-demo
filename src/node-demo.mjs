// Minimal Node.js (>= 24, JSPI required) prototype using the unkernel SDK.
import { MemoryFs, checkSupport, createKernel } from "unkernel";

const support = await checkSupport();
if (!support.ok) {
  console.error("Runtime cannot run unkernel:", support.problems.join("; "));
  console.error("Note: Node.js >= 24 is required for WebAssembly JSPI.");
  process.exit(1);
}

const mem = new MemoryFs({
  "hello.txt": "Hello from Node.js host!\n",
});

mem.onChange((change) => {
  console.log(`[MemoryFs] guest ${change.type}: ${change.path}`);
});

const vm = await createKernel({
  mounts: { "/mnt/host": mem },
});

const uname = await vm.exec("uname", ["-a"]);
console.log("uname:", uname.stdout.trim());

const cat = await vm.exec("cat", ["/mnt/host/hello.txt"]);
console.log("cat /mnt/host/hello.txt:", cat.stdout.trim());

await vm.exec("sh", ["-c", "echo 'written inside linux' > /mnt/host/reply.txt"]);
console.log("host read reply.txt:", mem.readText("/reply.txt").trim());

vm.write("poweroff\n");
const exit = await vm.exited;
console.log("VM exited:", exit);
