import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

interface ReservationRequest { operationId: string; eventId: string; slot: string }
interface Reservation extends ReservationRequest { reservationId: string }
interface ReservationFixtureOptions {
  /** The harness supplies a temporary database and the event and slots the caller may reserve. */
  eventId: string;
  slots: readonly string[];
  dropFirstReceipt?: boolean;
  lookupUnavailable?: () => boolean;
}

function operationKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9._:-]{1,128}$/.test(value)) throw new Error('Invalid reservation operation ID.');
  return value;
}

/** Isolated domain tool. It has no access to the platform database and cannot deliver or schedule work. */
export function openBoothReservations(databasePath: string, options: ReservationFixtureOptions) {
  const db = new DatabaseSync(databasePath);
  const eventId = options.eventId, slots = new Set(options.slots);
  let dropReceipt = options.dropFirstReceipt === true;
  db.exec(`
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS reservations (
      operation_id TEXT PRIMARY KEY NOT NULL, event_id TEXT NOT NULL, slot TEXT NOT NULL,
      reservation_id TEXT UNIQUE NOT NULL, UNIQUE(event_id,slot)
    );
    CREATE TABLE IF NOT EXISTS reservation_calls (
      call_no INTEGER PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES reservations(operation_id)
    );
  `);
  const record = db.prepare(`SELECT operation_id AS operationId,event_id AS eventId,slot,reservation_id AS reservationId
    FROM reservations WHERE operation_id=? AND event_id=?`);
  const get = (operationId: string): Reservation | undefined => {
    const row = record.get(operationId,eventId);
    return row && {operationId:String(row.operationId),eventId:String(row.eventId),slot:String(row.slot),reservationId:String(row.reservationId)};
  };
  return {
    reserve(input: ReservationRequest): Reservation {
      const operationId = operationKey(input.operationId);
      if (input.eventId !== eventId || !slots.has(input.slot)) throw new Error('Event or slot outside fixture scope.');
      db.exec('BEGIN IMMEDIATE');
      let reservation: Reservation;
      try {
        const previous = get(operationId);
        if (previous && previous.slot !== input.slot) throw new Error('Operation ID already refers to a different reservation.');
        reservation = previous ?? {operationId,eventId,slot:input.slot,reservationId:randomUUID()};
        if (!previous) db.prepare('INSERT INTO reservations(operation_id,event_id,slot,reservation_id) VALUES(?,?,?,?)')
          .run(operationId,eventId,input.slot,reservation.reservationId);
        db.prepare('INSERT INTO reservation_calls(operation_id) VALUES(?)').run(operationId);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      if (dropReceipt) {
        dropReceipt = false;
        throw new Error('Reservation receipt unavailable. Check the original operation ID.');
      }
      return reservation;
    },
    lookup(id: string) {
      const operationId = operationKey(id);
      if (options.lookupUnavailable?.()) return {state:'unavailable' as const,operationId};
      const reservation = get(operationId);
      return reservation ? {state:'recorded' as const,reservation} : {state:'not_found' as const,operationId};
    },
    close() { db.close(); }
  };
}
