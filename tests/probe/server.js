// Test-only RPC probe. Never installed by the production installer.
import { Plugin, Rpc } from "@opencode/plugin";
import { z } from "zod";

export default Plugin.define({
  id: "opencode-kernel-test-probe",
  async setup(context) {
    const registration = await context.rpc.register(Rpc.define({
      id: "kernel-test",
      events: {},
      methods: {
        inspect: { input: z.object({}), output: z.array(z.string()) },
        run: {
          input: z.object({ name: z.string(), args: z.record(z.string(), z.unknown()), sessionID: z.string() }),
          output: z.unknown(),
        },
      },
    }), {
      async inspect() { return (await context.tool.list()).map((tool) => tool.name); },
      async run(input, call) {
        const tool = (await context.tool.list()).find((tool) => tool.name === input.name);
        if (!tool) throw new Error(`Missing tool ${input.name}`);
        try {
          return await tool.execute(input.args, {
            sessionID: input.sessionID, agent: "build", messageID: "message-smoke",
            id: "call-smoke", signal: call.signal, progress: async () => {},
          });
        } catch (error) { return { error: error.message ?? String(error) }; }
      },
    });
    return () => registration.dispose();
  },
});
