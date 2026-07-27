import {
  McpIdempotencyExecution,
  McpIdempotencyService,
} from './mcp-idempotency.service';

type StoredReservation = {
  id: string;
  clientId: string;
  completedAt: Date | null;
  expiresAt: Date | null;
  workspaceId: string;
  idempotencyKey: string;
  leaseExpiresAt: Date | null;
  leaseOwner: string | null;
  lastError: string | null;
  operationStage: string;
  action: string;
  beforeState: unknown;
  requestHash: string | null;
  response: unknown;
  resourceType: string | null;
  status: string;
  targetState: unknown;
  resourceId: string | null;
  deletedAt: Date | null;
};

const client = {
  id: 'client-1',
  workspaceId: 'workspace-1',
  actorUserId: 'user-1',
  status: 'active',
};

const distributedTaskService = {
  runWithLock: jest.fn(
    async (_name: string, _ttlMs: number, task: () => Promise<unknown>) => ({
      acquired: true as const,
      value: await task(),
    }),
  ),
};

function createService(db: unknown) {
  return new McpIdempotencyService(
    db as never,
    distributedTaskService as never,
  );
}

function createFakeDb() {
  let sequence = 0;
  let reservation: StoredReservation | undefined;

  const activeReservation = () =>
    reservation && !reservation.deletedAt ? reservation : undefined;

  const db = {
    selectFrom: jest.fn(() => {
      const builder = {
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        executeTakeFirst: jest.fn(async () => activeReservation()),
      };
      return builder;
    }),
    insertInto: jest.fn(() => {
      let values: Omit<StoredReservation, 'id' | 'deletedAt'>;
      let ignoresConflict = false;
      const insert = () => {
        if (activeReservation()) {
          if (ignoresConflict) {
            return undefined;
          }
          throw new Error('duplicate key value violates unique constraint');
        }

        reservation = {
          ...values,
          id: `reservation-${++sequence}`,
          deletedAt: null,
        };
        return { id: reservation.id };
      };
      const builder = {
        values: jest.fn((nextValues) => {
          values = nextValues;
          return builder;
        }),
        onConflict: jest.fn(() => {
          ignoresConflict = true;
          return builder;
        }),
        returning: jest.fn().mockReturnThis(),
        execute: jest.fn(async () => insert()),
        executeTakeFirst: jest.fn(async () => insert()),
      };
      return builder;
    }),
    updateTable: jest.fn(() => {
      let values: Partial<StoredReservation> = {};
      const apply = () => {
        const current = activeReservation();
        if (!current) {
          return undefined;
        }
        reservation = { ...current, ...values };
        return { id: reservation.id };
      };
      const builder = {
        set: jest.fn((nextValues) => {
          values = nextValues;
          return builder;
        }),
        where: jest.fn().mockReturnThis(),
        returning: jest.fn().mockReturnThis(),
        execute: jest.fn(async () => apply()),
        executeTakeFirst: jest.fn(async () => apply()),
      };
      return builder;
    }),
  };

  return {
    db,
    getReservation: () => reservation,
    patchReservation: (patch: Partial<StoredReservation>) => {
      if (reservation) {
        reservation = { ...reservation, ...patch };
      }
    },
  };
}

describe('McpIdempotencyService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const createInput = (
    run: (execution: McpIdempotencyExecution) => Promise<unknown>,
    request = { title: 'A' },
  ) => ({
    client: client as never,
    action: 'create_page',
    idempotencyKey: 'request-1',
    request,
    resourceType: 'page',
    getResourceId: (response: unknown) =>
      (response as { page?: { id?: string } }).page?.id,
    run,
  });

  it('runs directly when no idempotency key is provided', async () => {
    const { db } = createFakeDb();
    const service = createService(db);
    const run = jest.fn().mockResolvedValue({ ok: true });

    await expect(
      service.run({ ...createInput(run), idempotencyKey: undefined }),
    ).resolves.toEqual({ ok: true });
    expect(run).toHaveBeenCalledTimes(1);
    expect(db.selectFrom).not.toHaveBeenCalled();
    expect(db.insertInto).not.toHaveBeenCalled();
  });

  it('replays a completed response without executing the operation again', async () => {
    const { db } = createFakeDb();
    const service = createService(db);
    const response = { page: { id: 'page-1' } };
    const run = jest.fn().mockResolvedValue(response);
    const input = createInput(run);

    await expect(service.run(input)).resolves.toEqual(response);
    await expect(service.run(input)).resolves.toEqual(response);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('canonicalizes object keys, arrays, and undefined values in request hashes', async () => {
    const { db } = createFakeDb();
    const service = createService(db);
    const response = { ok: true };
    const run = jest.fn().mockResolvedValue(response);
    const baseInput = {
      client: client as never,
      action: 'update_page',
      idempotencyKey: 'canonical-request-1',
      run,
    };

    await expect(
      service.run({
        ...baseInput,
        request: { z: 2, a: [undefined, 1] },
      }),
    ).resolves.toEqual(response);
    await expect(
      service.run({
        ...baseInput,
        request: { a: [undefined, 1], z: 2 },
      }),
    ).resolves.toEqual(response);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('reserves a key before concurrent requests can execute twice', async () => {
    const { db } = createFakeDb();
    const service = createService(db);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = jest.fn(async () => {
      await gate;
      return { page: { id: 'page-1' } };
    });
    const input = createInput(run);
    const first = service.run(input);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = service.run(input).then(
      () => null,
      (err: unknown) => err,
    );

    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(run).toHaveBeenCalledTimes(1);
      await expect(second).resolves.toMatchObject({
        message: 'Idempotent request is already in progress',
      });
    } finally {
      release();
      await Promise.allSettled([first, second]);
    }
  });

  it('rejects reuse of a key with a different request', async () => {
    const { db } = createFakeDb();
    const service = createService(db);
    const run = jest.fn().mockResolvedValue({ page: { id: 'page-1' } });

    await service.run(createInput(run));

    await expect(service.run(createInput(run, { title: 'B' }))).rejects.toThrow(
      'Idempotency key was already used with a different request',
    );
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('releases a failed reservation so the request can be retried', async () => {
    const { db, getReservation } = createFakeDb();
    const service = createService(db);
    const run = jest
      .fn()
      .mockRejectedValueOnce(new Error('write failed'))
      .mockResolvedValueOnce({ page: { id: 'page-1' } });
    const input = createInput(run);

    await expect(service.run(input)).rejects.toThrow('write failed');
    expect(getReservation()?.deletedAt).toBeInstanceOf(Date);
    await expect(service.run(input)).resolves.toEqual({
      page: { id: 'page-1' },
    });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('marks an expired unsafe lease for reconciliation instead of replaying it', async () => {
    const { db, getReservation, patchReservation } = createFakeDb();
    const service = createService(db);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = jest.fn(async () => {
      await gate;
      return { page: { id: 'page-1' } };
    });
    const input = createInput(run);
    const first = service.run(input);
    await new Promise((resolve) => setTimeout(resolve, 0));
    patchReservation({ leaseExpiresAt: new Date(Date.now() - 1000) });

    await expect(service.run(input)).rejects.toThrow(
      'lease expired and requires reconciliation',
    );
    expect(getReservation()?.status).toBe('needs_reconciliation');
    expect(run).toHaveBeenCalledTimes(1);

    release();
    await first;
  });

  it('checkpoints a mutated resource before the final response is stored', async () => {
    const { db, getReservation } = createFakeDb();
    const service = createService(db);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = jest.fn(async (execution: McpIdempotencyExecution) => {
      await execution.checkpointResourceId('page-1');
      await gate;
      return { page: { id: 'page-1' } };
    });
    const request = service.run(createInput(run));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(getReservation()?.resourceId).toBe('page-1');
    expect(getReservation()?.status).toBe('in_progress');

    release();
    await expect(request).resolves.toEqual({ page: { id: 'page-1' } });
    expect(getReservation()?.status).toBe('completed');
  });

  it('keeps a checkpointed failure for reconciliation instead of replaying it', async () => {
    const { db, getReservation } = createFakeDb();
    const service = createService(db);
    const run = jest.fn(async (execution: McpIdempotencyExecution) => {
      await execution.checkpoint({
        stage: 'page_mutated',
        resourceId: 'page-1',
      });
      throw new Error('response connection lost');
    });

    await expect(service.run(createInput(run))).rejects.toThrow(
      'response connection lost',
    );
    expect(getReservation()).toMatchObject({
      deletedAt: null,
      resourceId: 'page-1',
      operationStage: 'page_mutated',
      status: 'needs_reconciliation',
      lastError: 'MCP operation requires reconciliation (Error)',
    });
  });

  it('finalizes a response reconstructed from a checkpointed resource', async () => {
    const { db, getReservation } = createFakeDb();
    const service = createService(db);
    const response = { page: { id: 'page-1' }, recovered: true };
    const run = jest.fn(async (execution: McpIdempotencyExecution) => {
      await execution.checkpointResourceId('page-1');
      throw new Error('crashed after commit');
    });
    const input = createInput(run);

    await expect(service.run(input)).rejects.toThrow('crashed after commit');
    const reconcile = jest.fn().mockResolvedValue({
      outcome: 'completed',
      response,
    });

    await expect(service.run({ ...input, reconcile })).resolves.toEqual(
      response,
    );
    expect(run).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceId: 'page-1',
        operationStage: 'resource_checkpointed',
      }),
    );
    expect(getReservation()).toMatchObject({
      status: 'completed',
      response,
      operationStage: 'completed',
    });
  });

  it('retries a mutation only after reconciliation confirms it is safe', async () => {
    const { db } = createFakeDb();
    const service = createService(db);
    const response = { page: { id: 'page-1' } };
    const run = jest
      .fn()
      .mockImplementationOnce(async (execution: McpIdempotencyExecution) => {
        await execution.checkpointResourceId('page-1');
        throw new Error('uncertain write');
      })
      .mockResolvedValueOnce(response);
    const input = createInput(run);

    await expect(service.run(input)).rejects.toThrow('uncertain write');
    await expect(
      service.run({
        ...input,
        reconcile: jest.fn().mockResolvedValue({ outcome: 'retry' }),
      }),
    ).resolves.toEqual(response);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('locks an ambiguous mutation in repair-required state', async () => {
    const { db, getReservation } = createFakeDb();
    const service = createService(db);
    const run = jest.fn(async (execution: McpIdempotencyExecution) => {
      await execution.checkpointResourceId('page-1');
      throw new Error('partial mutation');
    });
    const input = createInput(run);

    await expect(service.run(input)).rejects.toThrow('partial mutation');
    await expect(
      service.run({
        ...input,
        reconcile: jest.fn().mockResolvedValue({ outcome: 'repair_required' }),
      }),
    ).rejects.toThrow('requires manual repair');
    expect(getReservation()?.status).toBe('repair_required');
    await expect(
      service.run({
        ...input,
        reconcile: jest.fn(),
      }),
    ).rejects.toThrow('requires manual repair');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('deletes reservations after their retention period', async () => {
    const executeTakeFirst = jest
      .fn()
      .mockResolvedValue({ numDeletedRows: BigInt(3) });
    const deleteBuilder = {
      where: jest.fn().mockReturnThis(),
      executeTakeFirst,
    };
    const deleteFrom = jest.fn().mockReturnValue(deleteBuilder);
    const service = createService({ deleteFrom });

    await expect(service.cleanupExpired()).resolves.toBe(3);
    expect(deleteFrom).toHaveBeenCalledWith('mcpIdempotencyKeys');
    expect(deleteBuilder.where).toHaveBeenCalledWith(
      'expiresAt',
      '<=',
      expect.any(Date),
    );
  });

  it('moves abandoned execution leases into the reconciliation queue', async () => {
    const updateBuilder = {
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      returning: jest.fn().mockReturnThis(),
      execute: jest
        .fn()
        .mockResolvedValue([{ id: 'reservation-1' }, { id: 'reservation-2' }]),
    };
    const updateTable = jest.fn().mockReturnValue(updateBuilder);
    const service = createService({ updateTable });

    await expect(service.markExpiredLeasesForReconciliation()).resolves.toBe(2);
    expect(updateBuilder.set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'needs_reconciliation',
        leaseOwner: null,
        leaseExpiresAt: null,
      }),
    );
    expect(updateBuilder.where).toHaveBeenCalledWith(
      'leaseExpiresAt',
      '<=',
      expect.any(Date),
    );
  });

  it('skips maintenance when another replica owns the task lock', async () => {
    const service = createService({});
    distributedTaskService.runWithLock.mockResolvedValueOnce({
      acquired: false,
    } as never);
    const expiredSpy = jest.spyOn(
      service,
      'markExpiredLeasesForReconciliation',
    );
    const cleanupSpy = jest.spyOn(service, 'cleanupExpired');

    await expect(service.maintainReservations()).resolves.toEqual({
      expiredLeases: 0,
      deletedRecords: 0,
    });
    expect(expiredSpy).not.toHaveBeenCalled();
    expect(cleanupSpy).not.toHaveBeenCalled();
  });

  it('renews the execution lease while a long-running operation is active', async () => {
    jest.useFakeTimers();
    const { db } = createFakeDb();
    const service = createService(db);
    const renewLease = jest
      .spyOn(
        service as unknown as {
          renewLease: (
            reservationId: string,
            leaseOwner: string,
          ) => Promise<void>;
        },
        'renewLease',
      )
      .mockResolvedValue(undefined);
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const task = (
      service as unknown as {
        withLeaseHeartbeat: (
          reservationId: string,
          leaseOwner: string,
          operation: () => Promise<string>,
        ) => Promise<string>;
      }
    ).withLeaseHeartbeat('reservation-1', 'owner-1', async () => {
      await gate;
      return 'done';
    });

    try {
      await jest.advanceTimersByTimeAsync(100_000);
      expect(renewLease).toHaveBeenCalledWith('reservation-1', 'owner-1');
      finish();
      await expect(task).resolves.toBe('done');
    } finally {
      jest.useRealTimers();
    }
  });
});
