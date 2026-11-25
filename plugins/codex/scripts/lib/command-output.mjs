const COMMAND_BYTES = 16 * 1024;
const TURN_BYTES = 256 * 1024;

const omitted = bytes => `[… ${bytes} bytes omitted …]`;
const minimumBytes = bytes => Math.min(bytes, Buffer.byteLength(omitted(bytes)));

function excerpt(text, size, limit) {
  const available = limit - Buffer.byteLength(omitted(size));
  if (available <= 0) return omitted(size);
  const bytes = Buffer.from(text);
  let head = Math.ceil(available / 2);
  let tail = size - Math.floor(available / 2);
  // Move cuts inside the budget to whole UTF-8 characters.
  while ((bytes[head] & 0xc0) === 0x80) head--;
  while ((bytes[tail] & 0xc0) === 0x80) tail++;
  return bytes.toString("utf8", 0, head) + omitted(tail - head) + bytes.toString("utf8", tail);
}

export function boundCommandOutput(commands = []) {
  // ACP stdout is provider-supplied JSON. Preserve its original type whenever
  // it fits, and budget its serialized representation if it is structured.
  const outputs = commands.map(({ aggregatedOutput }) => typeof aggregatedOutput === "string"
    ? aggregatedOutput : aggregatedOutput == null ? "" : JSON.stringify(aggregatedOutput));
  const sizes = outputs.map(output => Buffer.byteLength(output));
  // Reserve a marker (or the smaller original output) for each later command.
  let reserved = sizes.reduce((sum, size) => sum + minimumBytes(size), 0);
  let remaining = TURN_BYTES;
  return commands.map((command, index) => {
    const size = sizes[index];
    const minimum = minimumBytes(size);
    reserved -= minimum;
    const limit = Math.min(COMMAND_BYTES, remaining, Math.max(minimum, remaining - reserved));
    if (size <= limit) {
      remaining -= size;
      return command;
    }
    const { aggregatedOutput, ...metadata } = command;
    // Even the markers can exceed the cap in turns with thousands of commands.
    if (limit < minimum) return { ...metadata, aggregatedOutputOmittedBytes: size };
    const output = excerpt(outputs[index], size, limit);
    remaining -= Buffer.byteLength(output);
    return { ...metadata, aggregatedOutput: output };
  });
}
