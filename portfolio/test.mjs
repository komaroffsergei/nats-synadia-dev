import test from 'node:test';
import assert from 'node:assert/strict';
import {dryAnalysis} from '../src/dry-analysis.js';
import {db,FIXTURES,create,owned,event,serialize,cleanup} from '../src/portfolio-store.js';
test('Missing context is explicit in original dry-run formatter',()=>{assert.match(dryAnalysis({issueId:'DEMO',issue:{}}),/Описание пустое/)});
test('Session ownership and atomic event append',()=>{const job=create('a',FIXTURES[0],false);assert.ok(owned(job.id,'a'));assert.equal(owned(job.id,'b'),null);event(job.id,'first','one');event(job.id,'second','two');assert.equal(serialize(owned(job.id,'a')).events.length,3)});
test('Session quota and automatic expiry',()=>{for(let i=0;i<20;i++)create('quota',FIXTURES[0],false);assert.throws(()=>create('quota',FIXTURES[0],false),/20/);db.prepare('UPDATE jobs SET expires=0 WHERE owner=?').run('quota');cleanup();assert.equal(db.prepare('SELECT count(*) n FROM jobs WHERE owner=?').get('quota').n,0)});
