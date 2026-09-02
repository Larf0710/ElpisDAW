export class RoutedJobExecutorError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = 'RoutedJobExecutorError';
  }
}

export class RoutedJobExecutor {
  #activeRoute;
  #executors;

  constructor({ executors }) {
    if (
      !Array.isArray(executors) ||
      executors.length === 0 ||
      executors.some((executor) => !isJobExecutor(executor))
    ) {
      throw new TypeError(
        'RoutedJobExecutor requires executors with canHandleRequest, validateRequest, run, cancel, and shutdown.',
      );
    }

    this.#executors = Object.freeze([...executors]);
  }

  validateRequest(value) {
    return this.#selectExecutor(value).validateRequest(value);
  }

  async run(request, context) {
    const executor = this.#selectExecutor(request);

    if (this.#activeRoute) {
      throw new RoutedJobExecutorError(
        'ROUTED_EXECUTOR_BUSY',
        `Routed Job executor is already running ${this.#activeRoute.jobId}.`,
      );
    }

    const activeRoute = { executor, jobId: context?.jobId };
    this.#activeRoute = activeRoute;

    try {
      return await executor.run(request, context);
    } finally {
      if (this.#activeRoute === activeRoute) {
        this.#activeRoute = undefined;
      }
    }
  }

  async cancel(jobId) {
    const activeRoute = this.#activeRoute;

    if (!activeRoute) {
      return;
    }

    if (activeRoute.jobId !== jobId) {
      throw new RoutedJobExecutorError(
        'ROUTED_EXECUTOR_JOB_MISMATCH',
        `Cannot cancel ${jobId} while ${activeRoute.jobId} is active.`,
      );
    }

    await activeRoute.executor.cancel(jobId);
  }

  async shutdown() {
    await Promise.all(this.#executors.map((executor) => executor.shutdown()));
  }

  #selectExecutor(value) {
    const matches = this.#executors.filter((executor) =>
      executor.canHandleRequest(value),
    );

    if (matches.length !== 1) {
      throw new RoutedJobExecutorError(
        matches.length === 0
          ? 'JOB_PROVIDER_UNSUPPORTED'
          : 'JOB_PROVIDER_AMBIGUOUS',
        matches.length === 0
          ? 'GPU Job Provider is not supported.'
          : 'GPU Job Provider resolves to more than one executor.',
      );
    }

    return matches[0];
  }
}

function isJobExecutor(value) {
  return (
    value &&
    typeof value.canHandleRequest === 'function' &&
    typeof value.validateRequest === 'function' &&
    typeof value.run === 'function' &&
    typeof value.cancel === 'function' &&
    typeof value.shutdown === 'function'
  );
}
