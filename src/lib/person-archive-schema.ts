import type { Database } from "./sqlite";

export function ensurePersonArchiveTables(db: Database) {
	db.exec(`
    create table if not exists people (
      id text primary key, name text not null, description text not null default '',
      read_sequence integer not null default 0, merged_into text references people(id), created_at text not null, updated_at text not null
    );
    create table if not exists person_sources (
      id text primary key, person_id text not null references people(id),
      kind text not null check(kind in ('x','telegram')), identifier text not null,
      url text not null, profile_id text, enabled integer not null default 1,
      history_status text not null default 'queued', history_cursor text,
      latest_cursor text, media_cursor integer not null default 0,
      next_poll_at text not null, last_synced_at text, last_error text,
      created_at text not null, unique(kind,identifier)
    );
    create index if not exists person_sources_person on person_sources(person_id);
    create unique index if not exists person_x_identity on person_sources(profile_id) where kind='x' and profile_id is not null;
    create index if not exists person_sources_due on person_sources(enabled,next_poll_at);
    create table if not exists person_documents (
      sequence integer primary key autoincrement, id text not null unique,
      person_id text not null references people(id), source_id text references person_sources(id),
      external_id text, kind text not null check(kind in ('telegram','document')),
      title text not null, text text not null, published_at text not null, ingested_at text not null,
      source_url text, filename text, mime_type text, storage_key text, byte_size integer not null default 0,
      extraction_status text not null default 'indexed', raw_json text not null default '{}',
      content_hash text not null, unique(source_id,external_id)
    );
    create index if not exists person_documents_timeline on person_documents(person_id,published_at desc,id);
    create table if not exists person_document_chunks (
      sequence integer primary key autoincrement, document_id text not null references person_documents(id) on delete cascade,
      chunk_index integer not null, text text not null, start_offset integer not null, page_start integer not null,
      unique(document_id,chunk_index)
    );
    create virtual table if not exists person_chunks_fts using fts5(text,content='person_document_chunks',content_rowid='sequence',tokenize='unicode61');
    create trigger if not exists person_chunks_ai after insert on person_document_chunks begin
      insert into person_chunks_fts(rowid,text) values(new.sequence,new.text);
    end;
    create trigger if not exists person_chunks_ad after delete on person_document_chunks begin
      insert into person_chunks_fts(person_chunks_fts,rowid,text) values('delete',old.sequence,old.text);
    end;
    create index if not exists person_upload_dedupe on person_documents(person_id,content_hash) where kind='document';
    create virtual table if not exists person_documents_fts using fts5(title,text,content='person_documents',content_rowid='sequence',tokenize='unicode61');
    create trigger if not exists person_documents_ai after insert on person_documents begin
      insert into person_documents_fts(rowid,title,text) values(new.sequence,new.title,new.text);
    end;
    create trigger if not exists person_documents_ad after delete on person_documents begin
      insert into person_documents_fts(person_documents_fts,rowid,title,text) values('delete',old.sequence,old.title,old.text);
    end;
    create trigger if not exists person_documents_au after update of title,text on person_documents begin
      insert into person_documents_fts(person_documents_fts,rowid,title,text) values('delete',old.sequence,old.title,old.text);
      insert into person_documents_fts(rowid,title,text) values(new.sequence,new.title,new.text);
    end;
    create table if not exists person_events (
      sequence integer primary key autoincrement, person_id text not null references people(id),
      item_id text not null, created_at text not null, unique(person_id,item_id)
    );
    create index if not exists person_events_unread on person_events(person_id,sequence);
    create table if not exists person_assets (
      id text primary key, person_id text not null references people(id),
      source_id text not null references person_sources(id), document_id text, tweet_id text,
      remote_url text not null, kind text not null, mime_type text, storage_key text,
      byte_size integer not null default 0, status text not null default 'pending', last_error text,
      attempts integer not null default 0, next_attempt_at text not null, created_at text not null
    );
    create unique index if not exists person_assets_document on person_assets(source_id,document_id,remote_url) where document_id is not null;
    create unique index if not exists person_assets_tweet on person_assets(source_id,tweet_id,remote_url) where tweet_id is not null;
    create index if not exists person_assets_queue on person_assets(status,next_attempt_at);
    create table if not exists person_archive_state (key text primary key,value text not null);
  `);
}
