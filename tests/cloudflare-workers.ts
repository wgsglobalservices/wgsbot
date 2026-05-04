export class WorkflowEntrypoint<Env = unknown, _Params = unknown> {
  env: Env;

  constructor(_state: unknown, env: Env) {
    this.env = env;
  }
}
