import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import {readFile} from "node:fs/promises";
import {hash} from "../src/security.js";

// Never point this integration test at any owner/business database.
const url=process.env.TEST_DATABASE_URL;
if(url){
 const parsed=new URL(url);
 if(!["localhost","127.0.0.1"].includes(parsed.hostname)||
    parsed.pathname!=="/abud_os_test")
  throw Error("TEST_DATABASE_URL must point to an isolated LOCAL abud_os_test database");
}
test("PostgreSQL owner-only schema and optimistic workspace revision",{
 skip:!url?"No isolated TEST_DATABASE_URL provided":""
},async()=>{
 const pool=new pg.Pool({connectionString:url,max:1});
 try{
  const sql=await readFile(new URL("../db/schema.sql",import.meta.url),"utf8");
  await pool.query(sql);
  const id=123456,other=987654, empty={version:1,focus:[],projects:{},events:[]};
  const token="a".repeat(64);
  await pool.query("INSERT INTO oauth_states(state_hash,expires_at) VALUES ($1,NOW()+interval '10 minutes') ON CONFLICT DO NOTHING",[hash(token)]);
  const one=await pool.query("DELETE FROM oauth_states WHERE state_hash=$1 AND expires_at>NOW() RETURNING state_hash",[hash(token)]);
  const replay=await pool.query("DELETE FROM oauth_states WHERE state_hash=$1 AND expires_at>NOW() RETURNING state_hash",[hash(token)]);
  assert.equal(one.rowCount,1);assert.equal(replay.rowCount,0);
  await pool.query("INSERT INTO owner_sessions(token_hash,github_user_id,csrf_secret,expires_at) VALUES($1,$2,$3,NOW()+interval '7 days') ON CONFLICT DO NOTHING",[hash(token),id,"b".repeat(64)]);
  const session=await pool.query("SELECT github_user_id FROM owner_sessions WHERE token_hash=$1 AND expires_at>NOW()",[hash(token)]);
  assert.equal(Number(session.rows[0].github_user_id),id);
  await pool.query("INSERT INTO owner_workspaces(github_user_id,revision,data) VALUES($1,0,$2::jsonb) ON CONFLICT DO NOTHING",[id,JSON.stringify(empty)]);
  const updated=await pool.query("UPDATE owner_workspaces SET data=$1::jsonb,revision=revision+1 WHERE github_user_id=$2 AND revision=0 RETURNING revision",
    [JSON.stringify({version:1,focus:["sample-private"],projects:{},events:[]}),id]);
  assert.equal(updated.rows[0].revision,1);
  const stale=await pool.query("UPDATE owner_workspaces SET revision=revision+1 WHERE github_user_id=$1 AND revision=0 RETURNING revision",[id]);
  assert.equal(stale.rowCount,0);
  const denied=await pool.query("SELECT data FROM owner_workspaces WHERE github_user_id=$1",[other]);
  assert.equal(denied.rowCount,0);
  const owner=await pool.query("SELECT revision,data FROM owner_workspaces WHERE github_user_id=$1",[id]);
  assert.equal(owner.rows[0].data.focus[0],"sample-private");
  await pool.query("DELETE FROM owner_sessions WHERE token_hash=$1",[hash(token)]);
  await pool.query("DELETE FROM owner_workspaces WHERE github_user_id=$1",[id]);
 }finally{await pool.end();}
});
