import type {ExternalOperationAdapter,ExternalActor} from '../../server/collaboration/external-operations.js';
import {openBoothReservations} from './booth-reservations.js';

/** Registration belongs to the isolated exhibition. Room, member and exact event/slot are fixed by its operator. */
export function boothAdapter(path:string, permits:(actor:ExternalActor)=>boolean, dropFirstReceipt:boolean,
  lookupUnavailable:()=>boolean=()=>false) {
  const eventId='autumn', slot='A12', target={id:eventId+'-'+slot,title:'秋展 · 预约 A12 展位'};
  const domain=openBoothReservations(path,{eventId,slots:[slot],dropFirstReceipt,lookupUnavailable});
  const adapter:ExternalOperationAdapter={
    targets:actor=>permits(actor)?[target]:[],
    async issue(actor,object,operationId) {
      if(!permits(actor) || object.id!==target.id) throw new Error('Outside registration');
      const record=domain.reserve({eventId,slot,operationId});
      return {operationId:record.operationId,targetId:target.id,receipt:record.reservationId};
    },
    async lookup(actor,object,id) {
      if(!permits(actor) || object.id!==target.id) throw new Error('Outside registration');
      const record=domain.lookup(id);
      if(record.state==='recorded' && record.reservation.slot===slot)
        return {operationId:record.reservation.operationId,targetId:target.id,receipt:record.reservation.reservationId};
    },
  };
  return {adapter,target,close:domain.close};
}
