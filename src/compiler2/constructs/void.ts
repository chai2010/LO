import { LLVM } from "../../../ffigen/llvm-c/mod.ts";
import { ModuleContext } from "../compiler.ts";

export function buildVoid(ctx: ModuleContext): LLVM.ValueRef {
  const { llvm } = ctx;

  return llvm.GetUndef(llvm.VoidTypeInContext(ctx.context));
}
