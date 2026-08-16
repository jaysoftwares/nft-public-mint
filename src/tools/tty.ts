// Terminal prompts for the local tools.
//
// The CLI already has prompt.ts, but that module owns a readline interface tied
// to the wizard's lifecycle and is part of the frozen path. These tools use
// their own.
//
// One interface is shared across every prompt rather than created per question.
// A fresh interface per prompt looks fine interactively and silently loses data
// on piped input: the first one buffers everything stdin has to offer, so the
// second sees EOF and its callback never fires — the process then exits 0
// having done nothing. That mattered here because it made `wallets init`
// impossible to script or test.

import * as readline from "node:readline";

interface MutableOutput extends NodeJS.WriteStream {
  muted?: boolean;
}

let shared: readline.Interface | undefined;
let muted = false;
let currentPrompt = "";

function iface(): readline.Interface {
  if (shared) return shared;

  const output = process.stdout as MutableOutput;
  const rl = readline.createInterface({
    input: process.stdin,
    output,
    // Terminal mode is what allows echo suppression, and it only works on a
    // real TTY. Piped input falls back to a plain line reader.
    terminal: Boolean(process.stdin.isTTY),
  });

  // readline routes every keystroke through this hook. Swallowing all of it
  // except the prompt itself is what keeps a passphrase off the screen.
  const internals = rl as unknown as { _writeToOutput?: (text: string) => void };
  const original = internals._writeToOutput?.bind(rl);
  internals._writeToOutput = (text: string): void => {
    if (muted) {
      if (currentPrompt && text.includes(currentPrompt)) output.write(currentPrompt);
      return;
    }
    if (original) original(text);
    else output.write(text);
  };

  rl.on("close", () => {
    shared = undefined;
  });
  shared = rl;
  return rl;
}

// Piped input needs its own buffering. readline emits 'line' as fast as the
// stream delivers, while question() only listens for the next one — so any
// line arriving between one prompt resolving and the next being asked is
// dropped on the floor. A persistent listener and a queue close that gap.
const lineQueue: string[] = [];
const waiters: ((line: string) => void)[] = [];
let queueAttached = false;
let stdinEnded = false;

function attachQueue(rl: readline.Interface): void {
  if (queueAttached) return;
  queueAttached = true;
  rl.on("line", (line: string) => {
    const waiter = waiters.shift();
    if (waiter) waiter(line);
    else lineQueue.push(line);
  });
  rl.on("close", () => {
    stdinEnded = true;
    // Release anyone still waiting so the caller gets EOF rather than hanging.
    while (waiters.length > 0) waiters.shift()?.("");
  });
}

function nextLine(): Promise<string> {
  const queued = lineQueue.shift();
  if (queued !== undefined) return Promise.resolve(queued);
  if (stdinEnded) return Promise.resolve("");
  return new Promise((resolve) => waiters.push(resolve));
}

function ask(question: string, hide: boolean): Promise<string> {
  const rl = iface();

  if (!process.stdin.isTTY) {
    attachQueue(rl);
    process.stdout.write(question);
    return nextLine().then((line) => line.trim());
  }

  currentPrompt = question;
  muted = hide;

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      if (muted) {
        muted = false;
        process.stdout.write("\n");
      }
      resolve(answer.trim());
    });
  });
}

export function askText(question: string): Promise<string> {
  return ask(question, false);
}

/** Read a line without echoing it. Used for passphrases and private keys. */
export function askHidden(question: string): Promise<string> {
  return ask(question, true);
}

export async function askPassphrase(prompt = "Passphrase: ", confirm = false): Promise<string> {
  for (;;) {
    const first = await askHidden(prompt);
    if (first.length < 8) {
      // An empty answer on piped input means stdin ran out. Looping forever on
      // that would hang; say so instead.
      if (first.length === 0 && !process.stdin.isTTY) {
        throw new Error("No passphrase on stdin — pipe one in, or run with a terminal attached.");
      }
      console.log("  Too short — use at least 8 characters.");
      continue;
    }
    if (!confirm) return first;
    const second = await askHidden("Confirm passphrase: ");
    if (first === second) return first;
    console.log("  They don't match. Try again.");
  }
}

export async function askYesNo(question: string, fallback = false): Promise<boolean> {
  const suffix = fallback ? "[Y/n] " : "[y/N] ";
  const answer = (await askText(`${question} ${suffix}`)).toLowerCase();
  if (answer === "") return fallback;
  return answer === "y" || answer === "yes";
}

/** Release stdin so the process can exit. */
export function closePrompts(): void {
  shared?.close();
  shared = undefined;
}
