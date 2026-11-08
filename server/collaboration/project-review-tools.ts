import type { ProjectReviewScope } from '../../shared/collaboration.js';

const REVIEW_READ = { name:'project_review_read', description:'Read one of the relative paths named in this review. Returns current UTF-8 text and its SHA-256. Read the files on which your conclusion relies.', inputSchema:{type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false} };
const browse = {
  name: 'project_review_list', description: 'Browse visible entries in a project directory. Omit path for the root; use nextAfter as after to continue.',
  inputSchema: {type:'object',properties:{path:{type:'string'},after:{type:'string'}},additionalProperties:false},
};
const readVisible = {...REVIEW_READ, description:'Read a visible UTF-8 project file by its relative path and record its SHA-256 for this review.'};
const test = {
  name:'project_review_test', description:'Run a test in an isolated copy of the visible project. Provide the executable and its arguments separately. Check exitCode; quote failures or unavailable dependencies in your review.',
  inputSchema:{type:'object',properties:{argv:{type:'array',items:{type:'string'},minItems:1}},required:['argv'],additionalProperties:false},
};

export function supportedProjectNpmCheck(argv: readonly string[], projectNpmChecks = true) {
  if (argv[0] !== 'npm') return false;
  if (argv[1] === 'test') return argv.length === 2 || (argv[2] === '--' && (!projectNpmChecks || argv.length > 3));
  return projectNpmChecks && argv.length === 3 && argv[1] === 'run' && (argv[2] === 'typecheck' || argv[2] === 'build');
}

// The guest completed its snapshot inspection without launching the requested script.
export class MissingProjectScript extends Error {
  constructor(readonly script: string, readonly snapshotSha256: string) {
    super('package.json 未定义 ' + script + ' 脚本。');
  }
}

export function projectReviewTools(scope: ProjectReviewScope) {
  if (scope.mode !== 'project') return [REVIEW_READ];
  const check = scope.npmTest && scope.projectNpmChecks ? {
    ...test, description:test.description + ' Inspect package.json and run each requested check separately: npm test (optional arguments after --), npm run typecheck, or npm run build. Missing scripts are reported as skipped.'
  } : test;
  return [readVisible, browse, check];
}
