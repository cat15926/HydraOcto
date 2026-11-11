import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { openBoothReservations } from './fixtures/booth-reservations.js';

const scope = {eventId:'spring-fair',slots:['09:00','14:00']};
const request = {operationId:'room-1:booking-42',eventId:scope.eventId,slot:scope.slots[0]!};

function counts(file: string) {
  const auditor = new DatabaseSync(file,{readOnly:true});
  try {
    const evidence = auditor.prepare(`SELECT
      (SELECT COUNT(*) FROM reservations) AS bookings,
      (SELECT COUNT(*) FROM reservation_calls) AS calls,
      (SELECT reservation_id FROM reservations WHERE operation_id=?) AS receipt`).get(request.operationId)!;
    return {...evidence};
  } finally {auditor.close();}
}

for (const initiallyUnavailable of [false,true]) {
  test('booth fixture persists a real booking across lost reply and reopened connection; lookup unavailable=' + initiallyUnavailable, t => {
    const root = mkdtempSync(join(tmpdir(),'hydra-booth-')), file = join(root,'tool.sqlite');
    t.after(()=>rmSync(root,{recursive:true,force:true}));
    const issuing = openBoothReservations(file,{...scope,dropFirstReceipt:true});
    try {assert.throws(()=>issuing.reserve(request),/receipt unavailable/);} finally {issuing.close();}
    const committed = counts(file);
    assert.equal(committed.bookings,1); assert.equal(committed.calls,1); assert.ok(committed.receipt);
    let unavailable = initiallyUnavailable;
    const recovered = openBoothReservations(file,{...scope,lookupUnavailable:()=>unavailable});
    try {
      if (unavailable) {
        assert.deepEqual(recovered.lookup(request.operationId),{state:'unavailable',operationId:request.operationId});
        assert.deepEqual(counts(file),committed);
        unavailable = false;
      }
      const fromLedger = recovered.lookup(request.operationId);
      assert.deepEqual(fromLedger,{state:'recorded',reservation:{...request,reservationId:committed.receipt}});
      assert.deepEqual(recovered.lookup('other-operation'),{state:'not_found',operationId:'other-operation'});
      assert.deepEqual(counts(file),committed);
    } finally {recovered.close();}
  });
}

test('the reservation is scoped and immutable; an unnecessary second reserve remains auditable', t => {
  const root = mkdtempSync(join(tmpdir(),'hydra-booth-')), file=join(root,'tool.sqlite');
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const tool = openBoothReservations(file,scope);
  try {
    const receipt = tool.reserve(request);
    assert.throws(()=>tool.reserve({...request,eventId:'private-event'}),/outside fixture scope/);
    assert.throws(()=>tool.reserve({...request,slot:'not-offered'}),/outside fixture scope/);
    assert.throws(()=>tool.reserve({...request,slot:scope.slots[1]!}),/different reservation/);
    assert.throws(()=>tool.reserve({...request,operationId:'different-op'}),/UNIQUE constraint/);
    assert.deepEqual(tool.reserve(request),receipt);
    assert.deepEqual(counts(file),{bookings:1,calls:2,receipt:receipt.reservationId});
  } finally {tool.close();}
});
