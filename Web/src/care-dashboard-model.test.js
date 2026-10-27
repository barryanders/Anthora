import test from 'node:test';
import assert from 'node:assert/strict';
import { analysisState, reviewSuggestion } from './care-dashboard-model.js';
test('analysis distinguishes loading, failure, empty and ready without claiming a clean library',()=>{
 assert.equal(analysisState(null).known,false);
 assert.equal(analysisState({care:{total:20,analyzed:20,current:true}},true).known,false);
 assert.equal(analysisState({care:{total:0,analyzed:0,current:true}}).empty,true);
 const ready=analysisState({care:{total:20,analyzed:20,current:true}});
 assert.equal(ready.label,'Ready to review');assert.equal(ready.percent,100);
 const partial=analysisState({care:{total:20,analyzed:5,current:false}});
 assert.equal(partial.percent,25);assert.match(partial.detail,/15 checks remain/);
});
test('recommendation selects a real nonempty review and does not sum overlapping categories',()=>{
 assert.equal(reviewSuggestion(null),null);
 assert.equal(reviewSuggestion({profiles:{exactDuplicates:{items:0,bytes:100}}}),null);
 const picked=reviewSuggestion({profiles:{exactDuplicates:{items:2,bytes:400},downloadedClutter:{items:50,bytes:700},lowQuality:{items:30,bytes:300}}});
 assert.equal(picked.key,'downloadedClutter');assert.equal(picked.bytes,700);
});
