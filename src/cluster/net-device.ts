import type { Kernel, NetDevice } from "unkernel";

/**
 * Worker-side unkernel NetDevice bridging guest eth0 L2 Ethernet frames
 * to the host VirtualL2Switch via a Transferable MessagePort.
 */
export function createWorkerBridgeNetDevice(
  mac: Uint8Array,
  switchPort: MessagePort
): NetDevice {
  let attachedKernel: Kernel | null = null;

  switchPort.onmessage = (ev: MessageEvent<ArrayBuffer | Uint8Array>) => {
    if (!attachedKernel) return;
    const data = ev.data;
    const frame = data instanceof Uint8Array ? data : new Uint8Array(data);
    attachedKernel.receiveFrame(frame);
  };

  return {
    mac,
    attach(kernel: Kernel) {
      attachedKernel = kernel;
    },
    send(frame: Uint8Array) {
      // unkernel's wasm_driver_net_send already creates an isolated slice(),
      // so transferring frame.buffer never detaches Wasm linear memory.
      if (frame.byteOffset === 0 && frame.byteLength === frame.buffer.byteLength) {
        switchPort.postMessage(frame.buffer, [frame.buffer]);
      } else {
        const copy = frame.slice();
        switchPort.postMessage(copy.buffer, [copy.buffer]);
      }
    },
    close() {
      attachedKernel = null;
      switchPort.onmessage = null;
      try {
        switchPort.close();
      } catch {
        // Ignore already-closed port.
      }
    },
  };
}
