import type {RoomRuleTurn} from '../../shared/collaboration.js';

// An active domain can authorize a collection on its own commitment. Delivery,
// participant identity, deadlines and callbacks remain the collector's responsibility.
export interface RoomCollectionAuthorization {
 turn:RoomRuleTurn;
 members:string[];
 maxCollections:number;
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
