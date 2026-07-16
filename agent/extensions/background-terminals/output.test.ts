import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import { OutputBuffer, OutputCapture, RotatingSpill } from "./src/output.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("memory tail is UTF-8 safe, maximal, and strictly bounded", () => {
  const output = new OutputBuffer(5);
  output.push("head");
  output.push("éééé");
  assert.equal(output.totalBytes, 12);
  assert.equal(output.text(), "éé");
  assert.equal(Buffer.byteLength(output.text()), 4);
  assert.equal(output.truncatedBytes, 8);

  const splitChunks = new OutputBuffer(5);
  splitChunks.push("abcd");
  splitChunks.push("EFGH");
  assert.equal(splitChunks.text(), "dEFGH");
  assert.equal(Buffer.byteLength(splitChunks.text()), 5);
  assert.equal(splitChunks.truncatedBytes, 3);
});

test("rotating spill remains bounded and reports rotation/truncation honestly", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bt-output-"));
  const source = new PassThrough();
  const capture = new OutputCapture(
    source,
    new OutputBuffer(16),
    new RotatingSpill({
      directory,
      stem: "stdout",
      segmentBytes: 32,
      maxFiles: 2,
      highWaterMark: 8,
    }),
    () => {},
  );
  source.write("0123456789".repeat(20));
  source.end();
  await tick();
  await capture.flush(2_000);
  const view = capture.view();
  assert.equal(view.totalBytes, 200);
  assert.ok(Buffer.byteLength(view.text) <= 16);
  assert.ok(view.truncatedBytes > 0);
  assert.ok(view.spillFiles.length <= 2);
  assert.ok(view.spillRetainedBytes <= 64);
  assert.ok(view.spillDroppedBytes > 0);
  assert.ok(view.spillRotations > 0);
  assert.equal(view.spillComplete, false);
  assert.equal(
    view.spillFiles.every((file) => fs.existsSync(file)),
    true,
  );
  fs.rmSync(directory, { recursive: true, force: true });
});

test("write(false) pauses the matching readable and drain resumes it", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bt-pressure-"));
  const source = new PassThrough();
  let pauses = 0;
  let resumes = 0;
  const pause = source.pause.bind(source);
  const resume = source.resume.bind(source);
  source.pause = () => {
    pauses++;
    return pause();
  };
  source.resume = () => {
    resumes++;
    return resume();
  };
  const capture = new OutputCapture(
    source,
    new OutputBuffer(64),
    new RotatingSpill({
      directory,
      stem: "stdout",
      segmentBytes: 1 << 20,
      maxFiles: 1,
      highWaterMark: 1,
    }),
    () => {},
  );
  resumes = 0;
  source.write("x".repeat(128 * 1024));
  source.end();
  await tick();
  await capture.flush(2_000);
  assert.ok(pauses >= 1, `expected a backpressure pause, got ${pauses}`);
  assert.ok(resumes >= 1, `expected resume after drain, got ${resumes}`);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("spill stream errors and flush deadlines settle within bounds", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bt-errors-"));
  class ErrorWritable extends Writable {
    override _write(
      _chunk: Buffer,
      _encoding: BufferEncoding,
      callback: (error?: Error | null) => void,
    ): void {
      callback(new Error("disk failed"));
    }
  }
  const errorSource = new PassThrough();
  const errored = new RotatingSpill({
    directory,
    stem: "error",
    segmentBytes: 1024,
    maxFiles: 1,
    createWriteStream: (() =>
      new ErrorWritable()) as unknown as typeof fs.createWriteStream,
  });
  errored.write("data", errorSource);
  await tick();
  await errored.flush(100);
  assert.match(errored.state().spillError ?? "", /disk failed/);
  assert.equal(errored.state().spillComplete, false);

  class StuckWritable extends Writable {
    override _write(
      _chunk: Buffer,
      _encoding: BufferEncoding,
      _callback: (error?: Error | null) => void,
    ): void {
      // Intentionally never completes, forcing the bounded flush path.
    }
  }
  const source = new PassThrough();
  let resumed = 0;
  const resume = source.resume.bind(source);
  source.resume = () => {
    resumed++;
    return resume();
  };
  const spill = new RotatingSpill({
    directory,
    stem: "stuck",
    segmentBytes: 1024,
    maxFiles: 1,
    highWaterMark: 1,
    createWriteStream: (() =>
      new StuckWritable({
        highWaterMark: 1,
      })) as unknown as typeof fs.createWriteStream,
  });
  spill.write("firehose", source);
  const started = Date.now();
  await spill.flush(80);
  assert.ok(Date.now() - started < 500);
  assert.equal(spill.state().spillComplete, false);
  assert.match(spill.state().spillError ?? "", /flush exceeded/);
  assert.ok(resumed >= 1);
  fs.rmSync(directory, { recursive: true, force: true });
});
