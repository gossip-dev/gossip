import { stdin, stdout } from "node:process";

export async function readSecret(prompt: string): Promise<string> {
  if (!stdin.isTTY || !stdout.isTTY)
    throw new Error(
      "A secure interactive terminal is required for password entry",
    );
  stdout.write(prompt);
  return new Promise((resolve, reject) => {
    let value = "";
    const onData = (chunk: Buffer) => {
      for (const byte of chunk) {
        if (byte === 13 || byte === 10) {
          stdin.setRawMode?.(false);
          stdin.pause();
          stdin.off("data", onData);
          stdout.write("\n");
          resolve(value);
          return;
        }
        if (byte === 3) {
          stdin.setRawMode?.(false);
          stdin.pause();
          stdin.off("data", onData);
          reject(new Error("Password entry cancelled"));
          return;
        }
        if (byte === 8 || byte === 127) value = value.slice(0, -1);
        else value += String.fromCharCode(byte);
      }
    };
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}
