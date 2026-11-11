export interface MaterialBasis { key:string; versionId:string }
export interface PackageVersion {
  versionId:string;
  number:number;
  content:string;
  digest:string;
  createdAt:string;
  artifactVersionId?:string;
}
export interface VersionPackageView {
  id:string;
  obligationId:string;
  title:string;
  revision:number;
  editable:boolean;
  state:'draft'|'published'|'needs_review';
  materials:Array<{key:string;name:string;versionId:string;number?:number;content:string;history:{versionId:string;number:number}[]}>;
  parts:Array<{key:string;label:string;state:'missing'|'unknown'|'needs_review'|'pending'|'accepted';reason?:string;versionId?:string;number?:number;content?:string;evidenceId?:string;dependsOn?:string[];memberId:string;reviewerMemberId:string;basis?:MaterialBasis[];history:{versionId:string;submissionId:string;number:number;reviewId?:string;verdict?:'accept'|'changes_requested';note?:string;current:boolean}[]}>;
  edition?:{id:string;parts:{key:string;versionId:string;reviewId:string}[]};
}
