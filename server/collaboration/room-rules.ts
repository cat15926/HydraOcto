export const authorizedCollectionMaxMs = 30 * 60_000;

import type {RoomRuleTurn} from '../../shared/collaboration.js';

// An active domain can authorize a collection on its own commitment. Delivery,
// participant identity, deadlines and callbacks remain the collector's responsibility.
export interface RoomCollectionAuthorization {
 turn:RoomRuleTurn;
 members:string[];
 maxCollections:number;
}
// Leave enough time for a carrier account to serve the group in batches. Existing
// ordinary collections keep their two-minute default and ten-minute upper bound.
export function collectionWindow(targetCount:number, authorization?:RoomCollectionAuthorization) {
 if(!authorization)return {defaultMs:120_000,maximumMs:600_000};
 return {defaultMs:Math.min(authorizedCollectionMaxMs,Math.max(120_000,targetCount*120_000)),maximumMs:authorizedCollectionMaxMs};
}
interface RoomRulesProvider {
 collection(id:unknown,room:string,owner:string):RoomCollectionAuthorization|undefined;
 assertDelivery(id:string,room:string,summary:unknown):void;
}
export class RoomRules {
 constructor(private readonly providers:RoomRulesProvider[]){}
 collection(id:unknown,room:string,owner:string){
  for(const provider of this.providers){const scope=provider.collection(id,room,owner);if(scope)return scope;}
 }
 assertDelivery(id:string,room:string,summary:unknown){for(const provider of this.providers)provider.assertDelivery(id,room,summary);}
}
