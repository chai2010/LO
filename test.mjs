// @ts-check

import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs/promises";
import { WASI } from "node:wasi";
import crypto from "node:crypto";

const COMPILER_PATH = "./target/wasm32-unknown-unknown/release/lo.wasm";

const compile = await loadCompilerWithWasiAPI(COMPILER_PATH);

test("ffi, file and stdin inputs all work the same", async () => {
    const compileFuncAPI = await loadCompilerWithFuncAPI(COMPILER_PATH);
    const compileMockedStdinAPI = await loadCompilerWithWasiAPI(
        COMPILER_PATH,
        true
    );

    const output1 = await compile("./examples/test/42.lo");
    const output2 = await compileFuncAPI("./examples/test/42.lo");
    const output3 = await compileMockedStdinAPI("./examples/test/42.lo");

    assert.deepStrictEqual(output1.buffer, output2.buffer);
    assert.deepStrictEqual(output2.buffer, output3.buffer);
});

test("compiles 42", async () => {
    const output = await compile("./examples/test/42.lo");

    const program = await loadWasm(output);
    const result = program.main();

    assert.strictEqual(result, 42);
});

test("compiles factorial", async () => {
    const output = await compile("./examples/test/factorial.lo");

    const program = await loadWasm(output);
    const result = program.factorial(5);

    assert.strictEqual(result, 120);
});

test("compiles locals", async () => {
    const output = await compile("./examples/test/locals.lo");

    const program = await loadWasm(output);
    assert.deepEqual(program.sub(5, 3), 2);
});

test("compiles import", async () => {
    const output = await compile("./examples/test/import.lo");

    const logs = [];
    const program = await loadWasm(output, {
        utils: { debug: (x) => logs.push(x) },
    });

    program.main();
    assert.deepEqual(logs, [1, 2, 3]);
});

test("compiles globals", async () => {
    const output = await compile("./examples/test/globals.lo");

    const program = await loadWasm(output);
    const result = program.main();

    assert.strictEqual(result, 69);
});

test("compiles methods", async () => {
    const output = await compile("./examples/test/methods.lo");

    const program = await loadWasm(output);
    const result = program.main();

    assert.strictEqual(result, 1);
});

test("compiles nesting", async () => {
    const output = await compile("./examples/test/nesting.lo");

    const program = await loadWasm(output);
    const result = program.main();

    assert.strictEqual(result, 16);
});

test("compiles struct", async () => {
    const output = await compile("./examples/test/struct.lo");

    const program = await loadWasm(output);
    const result = program.main();

    assert.strictEqual(result, 13);
});

test("compiles nested-if-break", async () => {
    const output = await compile("./examples/test/nested-if-break.lo");

    const program = await loadWasm(output);
    const result = program.main();

    assert.strictEqual(result, 1);
});

test("compiles struct-ref", async () => {
    const output = await compile("./examples/test/struct-ref.lo");

    const program = await loadWasm(output);
    const result = program.main();

    assert.strictEqual(result, 3);
});

test("compiles wasi", async () => {
    const output = await compile("./examples/lib/wasi.lo");

    const wasi = new WASI({ version: "preview1" });
    const wasm = await WebAssembly.compile(output);
    await WebAssembly.instantiate(
        wasm,
        // @ts-ignore
        wasi.getImportObject()
    );
});

test("compiles std", async () => {
    const output = await compile("./examples/lib/std.test.lo");

    await loadWasm(output);
});

test("compiles vec", async () => {
    const output = await compile("./examples/test/vec.test.lo");
    const lib = await loadWasm(output);

    const vec = lib.vec_new(4, 1);

    lib.vec_push_u8(vec, 1);

    lib.vec_push_u8(vec, 3);
    lib.vec_push_u8(vec, 2);
    lib.vec_swap(vec, 1, 2);

    storeData(lib.memory, 1000, new Uint8Array([4, 5]));
    lib.vec_push_all(vec, 1000, 2);

    storeData(lib.memory, 1000, new Uint8Array([6]));
    lib.vec_push_all(vec, 1000, 1);

    lib.vec_push_u8(vec, 7);

    assert.strictEqual(lib.vec_get_u8(vec, 0), 1);
    assert.strictEqual(lib.vec_get_u8(vec, 1), 2);
    assert.strictEqual(lib.vec_get_u8(vec, 2), 3);
    assert.strictEqual(lib.vec_get_u8(vec, 3), 4);
    assert.strictEqual(lib.vec_get_u8(vec, 4), 5);
    assert.strictEqual(lib.vec_get_u8(vec, 5), 6);
    assert.strictEqual(lib.vec_get_u8(vec, 6), 7);
    assert.strictEqual(lib.vec_len(vec), 7);
});

test("compiles hello world", async () => {
    const program = await compile("./examples/hello-world.lo");

    const output = await runWithTmpFile(async (stdout, stdoutFile) => {
        await runWASI(program, { stdout: stdout.fd });
        return fs.readFile(stdoutFile, { encoding: "utf-8" });
    });

    assert.strictEqual(output, "Hello World!\n");
});

test("compiles hello world (raw)", async () => {
    const program = await compile("./examples/hello-world-raw.lo");

    const output = await runWithTmpFile(async (stdout, stdoutFile) => {
        await runWASI(program, { stdout: stdout.fd });
        return fs.readFile(stdoutFile, { encoding: "utf-8" });
    });

    assert.strictEqual(output, "Hello World!\n");
});

test("compiles echo", async () => {
    const program = await compile("./examples/echo.lo");

    const output = await runWithTmpFile(async (stdin, stdinFile) => {
        await fs.writeFile(stdinFile, "abc");
        return runWithTmpFile(async (stdout, stdoutFile) => {
            await runWASI(program, { stdin: stdin.fd, stdout: stdout.fd });
            return fs.readFile(stdoutFile, { encoding: "utf-8" });
        });
    });

    assert.strictEqual(output, "abc");
});

test("compiles args", async () => {
    const program = await compile("./examples/test/args.test.lo");

    const output = await runWithTmpFile(async (stdout, stdoutFile) => {
        await runWASI(program, {
            stdout: stdout.fd,
            args: ["123", "456", "789"],
        });
        return fs.readFile(stdoutFile, { encoding: "utf-8" });
    });

    assert.strictEqual(output, "123\n456\n789\n");
});

test("compiles cat", async () => {
    const program = await compile("./examples/cat.lo");

    const output = await runWithTmpFile(async (stdout, stdoutFile) => {
        await runWASI(program, {
            stdout: stdout.fd,
            args: ["args.lo", "examples/test/42.lo"],
            preopens: { ".": "." },
        });
        return fs.readFile(stdoutFile, { encoding: "utf-8" });
    });

    assert.strictEqual(
        output,
        await fs.readFile("examples/test/42.lo", "utf-8")
    );
});

test("compiles string-pooling", async () => {
    const program = await compile("./examples/test/string-pooling.lo");

    const output = await runWithTmpFile(async (stdout, stdoutFile) => {
        await runWASI(program, { stdout: stdout.fd });
        return fs.readFile(stdoutFile, { encoding: "utf-8" });
    });

    assert.strictEqual(output, "108\n");
});

test("compiles struct-in-struct", async () => {
    const program = await compile("./examples/test/struct-in-struct.lo");

    const output = await runWithTmpFile(async (stdout, stdoutFile) => {
        await runWASI(program, { stdout: stdout.fd });
        return fs.readFile(stdoutFile, { encoding: "utf-8" });
    });

    assert.strictEqual(output, "3\n3\n3\n3\n3\n3\n3\n");
});

test("compiles heap-alloc", async () => {
    const program = await compile("./examples/test/heap-alloc.lo");

    const output = await runWithTmpFile(async (stdout, stdoutFile) => {
        await runWASI(program, { stdout: stdout.fd });
        return fs.readFile(stdoutFile, { encoding: "utf-8" });
    });

    assert.strictEqual(
        output,
        dropPadding(`
            heap::TOTAL_ALLOCATED; // 1048576
            let p = heap::alloc(1); // 1048589
            heap::free(p);
            p = heap::alloc(1); // 1048589
            p = heap::alloc(1); // 1048606
        `)
    );
});

test("compiles defer", async () => {
    const program = await compile("./examples/test/defer.lo");

    const output = await runWithTmpFile(async (stdout, stdoutFile) => {
        await runWASI(program, { stdout: stdout.fd });
        return fs.readFile(stdoutFile, { encoding: "utf-8" });
    });

    assert.strictEqual(
        output,
        dropPadding(`
            defer(scope1): 3
            defer(scope1): 2
            defer(scope1): 1
            -------------
            defer(scope2): 2
            defer(scope2): 1
            -------------
            defer(scope2): 3
            defer(scope2): 2
            defer(scope2): 1
            -------------
            defer(return): 3
            defer(return): 2
            defer(return): 1
            `)
    );
});

{
    test("aoc 2020 day 1", async () => {
        const part1 = await runAoc("./examples/aoc2020/1.lo");
        assert.strictEqual(part1, "157059\n");

        const part2 = await runAoc("./examples/aoc2020/1-part2.lo");
        assert.strictEqual(part2, "165080960\n");
    });

    test("aoc 2020 day 2", async () => {
        const part1 = await runAoc("./examples/aoc2020/2.lo");
        assert.strictEqual(part1, "560\n");

        const part2 = await runAoc("./examples/aoc2020/2-part2.lo");
        assert.strictEqual(part2, "303\n");
    });

    test("aoc 2020 day 3", async () => {
        const part1 = await runAoc("./examples/aoc2020/3.lo");
        assert.strictEqual(part1, "151\n");

        const part2 = await runAoc("./examples/aoc2020/3-part2.lo");
        assert.strictEqual(part2, "7540141059\n");
    });

    test("aoc 2020 day 4", async () => {
        const part1 = await runAoc("./examples/aoc2020/4.lo");
        assert.strictEqual(part1, "264\n");
    });

    async function runAoc(path) {
        const program = await compile(path);

        return await runWithTmpFile(async (stdout, stdoutFile) => {
            await runWASI(program, {
                stdout: stdout.fd,
                preopens: { ".": "examples" },
            });
            return fs.readFile(stdoutFile, { encoding: "utf-8" });
        });
    }
}

// utils

/**
 * @param {string} compilerPath
 * @returns {Promise<(sourcePath: string) => Promise<Uint8Array>>}
 */
async function loadCompilerWithFuncAPI(compilerPath) {
    const compiler = await loadWasm(await fs.readFile(compilerPath), {
        wasi_snapshot_preview1: new Proxy({}, { get: () => () => 0 }),
    });

    return async (sourcePath) => {
        const fileNameBuf = Buffer.from("<stdin>.lo");
        const fileName = storeData(
            compiler.memory,
            compiler.mem_alloc(fileNameBuf.byteLength),
            fileNameBuf
        );

        const srcBuf = await fs.readFile(sourcePath);
        const src = storeData(
            compiler.memory,
            compiler.mem_alloc(srcBuf.byteLength),
            srcBuf
        );

        const [ok, outPtr, outSize] = compiler.compile(
            fileName.ptr,
            fileName.size,
            src.ptr,
            src.size
        );

        const output = new Uint8Array(outSize);
        output.set(new Uint8Array(compiler.memory.buffer, outPtr, outSize));

        compiler.mem_free(src.ptr, src.size);
        compiler.mem_free(outPtr, outSize);

        if (!ok) {
            throw new Error(new TextDecoder().decode(output));
        }

        return output;
    };
}

/**
 * @param {string} compilerPath
 * @returns {Promise<(sourcePath: string) => Promise<Promise<Buffer>>>}
 */
async function loadCompilerWithWasiAPI(compilerPath, mockStdin = false) {
    const mod = await WebAssembly.compile(await fs.readFile(compilerPath));

    /**
     * @param {string} [fileName]
     * @param {number} [stdinFd]
     */
    const compile = (fileName, stdinFd) =>
        runWithTmpFile(async (stderr, stderrFile) =>
            runWithTmpFile(async (stdout, stdoutFile) => {
                const wasi = new WASI({
                    version: "preview1",
                    stdin: stdinFd,
                    stdout: stdout.fd,
                    stderr: stderr.fd,
                    args: [
                        "lo.wasm",
                        ...(fileName !== undefined ? [fileName] : []),
                    ],
                    preopens: { ".": "examples" },
                });

                const instance = await WebAssembly.instantiate(
                    mod,
                    // @ts-ignore
                    wasi.getImportObject()
                );

                const exitCode = /** @type {unknown} */ (wasi.start(instance));

                if (exitCode ?? 0 !== 0) {
                    throw new Error(await fs.readFile(stderrFile, "utf-8"));
                }

                return fs.readFile(stdoutFile);
            })
        );

    /**
     * @param {string} sourcePath
     */
    return (sourcePath) => {
        if (!mockStdin) {
            sourcePath = sourcePath.slice("./examples/".length);
            return compile(sourcePath);
        }

        return runWithTmpFile(async (stdin, stdinFile) => {
            await fs.writeFile(stdinFile, await fs.readFile(sourcePath));

            return compile(undefined, stdin.fd);
        });
    };
}

/**
 * @param {BufferSource} data
 * @param {WebAssembly.Imports} [imports]
 * @returns {Promise<any>}
 */
async function loadWasm(data, imports) {
    const mod = await WebAssembly.instantiate(data, imports);
    return mod.instance.exports;
}

/**
 * @param {{buffer: ArrayBufferLike;}} memory
 * @param {number} ptr
 * @param {Uint8Array} data
 */
function storeData(memory, ptr, data) {
    const region = { ptr, size: data.byteLength };

    new Uint8Array(memory.buffer, region.ptr, region.size).set(data);

    return region;
}

/**
 * @param {BufferSource} data
 * @param {Omit<import("node:wasi").WASIOptions, 'version'>} [wasiOptions]
 */
async function runWASI(data, wasiOptions, additionalImports = {}) {
    const wasi = new WASI({ version: "preview1", ...wasiOptions });

    const wasm = await WebAssembly.compile(data);
    const instance = await WebAssembly.instantiate(wasm, {
        // @ts-expect-error
        ...wasi.getImportObject(),
        ...{ console },
        ...additionalImports,
    });

    wasi.start(instance);
}

/**
 * @template T
 * @param {(file: import("node:fs/promises").FileHandle, fileName: string) => T} run
 */
async function runWithTmpFile(run) {
    const mockOutputFileName = `tmp/${crypto.randomUUID()}.tmp`;
    const mockOutputFile = await fs.open(mockOutputFileName, "w+");

    try {
        return await run(mockOutputFile, mockOutputFileName);
    } finally {
        await mockOutputFile.close();
        await fs.unlink(mockOutputFileName);
    }
}

function dropPadding(/** @type {string} */ str) {
    return str
        .slice(1)
        .split("\n")
        .map((s) => s.trimStart())
        .join("\n");
}
