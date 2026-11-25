---
slug: postgresql-cdc-replay-xa
title: "One PostgreSQL Row, Two Commits: What a SeaTunnel CDC Restart Can Hide"
description: "A Docker-verified comparison of ordinary JDBC replay and two PostgreSQL XA checkpoint recovery windows on SeaTunnel Zeta 3.1.0."
tags: [SeaTunnel, PostgreSQL, MySQL, CDC, "Data Engineering"]
authors:
  - name: David Zollo
    title: Apache SeaTunnel Contributor
    url: https://github.com/davidzollo
    image_url: https://github.com/davidzollo.png
---

After a MySQL-to-PostgreSQL CDC job recovered, order 42 was exactly where it should have been: one row, status `PAID`. The audit table told a different story. It contained two committed entries with the same `change_id`, even though the source order had been updated only once.

A primary key keeps the order from appearing twice. It does not stop an upsert from updating the same row twice or firing its update trigger again. If that trigger records a business event, a correct final row can hide a duplicate side effect.

I tested three failure windows in local Docker: one with ordinary JDBC writes and two with XA. The setup was Apache SeaTunnel 3.1.0 (Zeta), MySQL 8.0.46, PostgreSQL 16.6, and pgJDBC 42.7.3. Each run stopped the entire single-node Zeta process and recovered manually with `--restore-with-checkpoint`. The results do not cover PostgreSQL failover, automatic recovery in a multi-node Zeta cluster, or other driver versions.

## How the second audit row got there

A completed checkpoint records a MySQL binlog position, P0. The job reads an update after P0 and commits it to PostgreSQL, but crashes before persisting the checkpoint that includes that update. PostgreSQL retains the first write. SeaTunnel resumes from P0 and can read the update again.

```text
Before the crash:  checkpoint at P0 → read update → PostgreSQL commits
After the crash:   restore P0 → read the same update → PostgreSQL commits again
```

In the control run, with one writer and `batch_size = 1`, I sent SIGKILL after PostgreSQL committed and before the next checkpoint reached disk. Restoring checkpoint 1 left a single `PAID` row and increased the committed audit count for the test `change_id` from one to two. Both audit rows held the target trigger's `NEW` value. They were not the CDC event's `UPDATE_BEFORE` and `UPDATE_AFTER` images.

[PostgreSQL's `ON CONFLICT DO UPDATE`](https://www.postgresql.org/docs/17/sql-insert.html#SQL-ON-CONFLICT) can write the same values back to one row while firing an update trigger again. An older event arriving after a newer one can even put an earlier value back. Before relying on upsert for convergence, check the target's unique constraint, event ordering for each key, and whether another job also writes to that table.

For the generated-SQL path, SeaTunnel can [coalesce changes for the same non-null key within one writer's buffer batch](https://github.com/apache/seatunnel/blob/2d3983aad94a2df4505fffa48e54909abcc49a1a/seatunnel-connectors-v2/connector-jdbc/src/main/java/org/apache/seatunnel/connectors/seatunnel/jdbc/internal/executor/BufferReducedBatchStatementExecutor.java#L66-L128). To test crash replay, send one uniquely tagged update across the failure boundary. Comparing the raw CDC event count to the number of audit rows can give the wrong answer.

## What changes with XA

With an XA JDBC sink, the writer flushes its batch and prepares the PostgreSQL transaction during the checkpoint. Other sessions cannot see the writes yet. Zeta [persists the checkpoint before issuing the completion notification](https://github.com/apache/seatunnel/blob/2d3983aad94a2df4505fffa48e54909abcc49a1a/seatunnel-engine/seatunnel-engine-server/src/main/java/org/apache/seatunnel/engine/server/checkpoint/CheckpointCoordinator.java#L1409-L1455); the prepared transaction is committed afterward.

```text
Flush and PREPARE → Persist checkpoint → Notify completion → COMMIT
```

A prepared transaction is not, by itself, a reason to commit it. If the checkpoint is durable but the commit outcome is unknown, SeaTunnel reconciles the checkpoint's XA transaction IDs (XIDs) with the database's recovery scan.

In [the 3.1.0 recovery code](https://github.com/apache/seatunnel/blob/2d3983aad94a2df4505fffa48e54909abcc49a1a/seatunnel-connectors-v2/connector-jdbc/src/main/java/org/apache/seatunnel/connectors/seatunnel/jdbc/sink/JdbcSinkAggregatedCommitter.java#L200-L271), a batch with no matching XIDs is treated as already resolved. Missing XIDs before the first match are skipped; a missing XID after that point causes recovery to fail. An empty scan cannot prove a commit: a manual rollback or a connection to the wrong database can also leave no matching XID. SeaTunnel commits XIDs individually, so different writers' results need not become visible at the same time.

### Both XA recovery windows failed in this setup

| Crash point | Restored checkpoint | Observed result |
| --- | --- | --- |
| PostgreSQL had prepared the transaction, but checkpoint 2 was not on disk. | 1 | The order stayed `NEW`. Zero committed audit rows, one prepared transaction. The replayed write waited on the old transaction's lock. |
| Checkpoint 2 was on disk, but Zeta had not sent its completion notification. | 2 | The order stayed `NEW`. Zero committed audit rows, one prepared transaction. Recovery found the XID, but pgJDBC rejected the second-phase commit and the job failed. |

In the first run, recovery assigned a new job ID. The [XA writer's cleanup path](https://github.com/apache/seatunnel/blob/2d3983aad94a2df4505fffa48e54909abcc49a1a/seatunnel-connectors-v2/connector-jdbc/src/main/java/org/apache/seatunnel/connectors/seatunnel/jdbc/internal/xa/XaGroupOpsImpl.java#L119-L147) checks that a recovered transaction [belongs to the current job and subtask](https://github.com/apache/seatunnel/blob/2d3983aad94a2df4505fffa48e54909abcc49a1a/seatunnel-connectors-v2/connector-jdbc/src/main/java/org/apache/seatunnel/connectors/seatunnel/jdbc/internal/xa/SemanticXidGenerator.java#L78-L94) before rolling it back. A log line saying `rollback 1 recovered transactions` did not mean the old transaction had been rolled back. The engine rejected the attempt to reuse the original job ID with the same restore command.

In the second run, pgJDBC reported: `Not implemented: 2nd phase commit must be issued using an idle connection.` PostgreSQL logged a `PREPARE TRANSACTION` for each test XID, with no corresponding commit or rollback.

## Three settings to check before testing

1. **JDBC sink XA settings.** Use `is_exactly_once = true`, `xa_data_source_class_name = "org.postgresql.xa.PGXADataSource"`, and `max_retries = 0`. A test submission with `max_retries = 3` failed [configuration validation](https://github.com/apache/seatunnel/blob/2d3983aad94a2df4505fffa48e54909abcc49a1a/seatunnel-connectors-v2/connector-jdbc/src/main/java/org/apache/seatunnel/connectors/seatunnel/jdbc/sink/JdbcSinkFactory.java#L460-L476). Leave Zeta's `sink.flush.interval` unset for this mode. The MySQL CDC source's `exactly_once` flag does not enable XA on the JDBC sink.
2. **Commit and recovery attempts.** `max_commit_attempts` defaults to 3 and includes the first commit attempt for a batch. Recovery scans use the same configured limit but count attempts separately. It is not a job-wide retry budget or a retry setting for ordinary batch writes.
3. **Prepared transactions.** Size [`max_prepared_transactions`](https://www.postgresql.org/docs/17/runtime-config-resource.html#GUC-MAX-PREPARED-TRANSACTIONS) for the expected concurrent prepared transactions. Monitor their count and age because they can retain locks. Do not rely on `transaction_timeout_sec` to clean them up: with pgJDBC 42.7.3, `setTransactionTimeout(30)` returned `false`, and the reported timeout stayed at zero, consistent with [the driver's implementation](https://github.com/pgjdbc/pgjdbc/blob/REL42.7.3/pgjdbc/src/main/java/org/postgresql/xa/PGXAConnection.java#L634-L649).

Connect to the sink's actual PostgreSQL database and inspect prepared transactions:

```sql
SELECT transaction, gid, owner, now() - prepared AS prepared_age
FROM pg_prepared_xacts
WHERE database = current_database()
ORDER BY prepared;
```

To match a SeaTunnel XID, use the driver's encoded `gid`. The `transaction` column is PostgreSQL's internal transaction ID. Check the checkpoint and sink logs before taking any manual action.

## Make crash recovery a release test

Use an isolated database, one seeded order, and one source update with a unique `change_id`. An `AFTER UPDATE` trigger on the target should append the order ID and change ID to an audit table in the same PostgreSQL transaction. Do not deduplicate the audit table by `change_id` or have the trigger skip updates whose old and new values match. Either choice can hide the replay you are trying to detect.

Wait for a baseline checkpoint before writing the test update. Preserve checkpoint storage and stop the test Zeta process abruptly; a normal cancellation or a savepoint is not a substitute. For the XA runs, confirm from a separate database session that the test transaction is prepared and that no test audit row is visible before interrupting the process. On restart, verify which checkpoint was actually used. See the [Zeta checkpoint restore documentation](https://seatunnel.apache.org/docs/3.1.0/engines/zeta/state-storage-and-recovery/#restoring-from-the-latest-completed-checkpoint).

Record the checkpoint ID, the XID when available, the target value, and the result of this query:

```sql
SELECT count(*) AS committed_updates
FROM order_audit
WHERE order_id = 42 AND change_id = 'replay-test-001';
```

If the pipeline only promises the latest state, validate the final value by key and verify that an older event cannot overwrite a newer one. If it also promises one committed audit entry per change, require all three outcomes in **both** XA failure windows: the correct target value, exactly one committed audit row for the test change, and no leftover prepared transaction for the test. Test database failover and side effects outside the PostgreSQL transaction separately.

Neither XA run cleared that gate on the manual restore path tested here. After recovery, query the order by its ID and then query the audit by `change_id`. The first query tells you whether order 42 is paid. The second tells you what happened to that particular update.
