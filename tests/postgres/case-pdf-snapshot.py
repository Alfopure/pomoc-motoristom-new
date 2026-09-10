"""PDF snapshot contract; disposable loopback-only PostgreSQL, never application env."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from uuid import uuid4
import re
import unittest
import psycopg
ROOT = Path(__file__).resolve().parents[2]
LOCAL = dict(host='127.0.0.1', port=55432, user='postgres', autocommit=True)
ORG='10000000-0000-0000-0000-000000000001'
ACTOR='20000000-0000-0000-0000-000000000001'
CASE='40000000-0000-0000-0000-000000000001'
CONTACT='50000000-0000-0000-0000-000000000001'
VEHICLE='60000000-0000-0000-0000-000000000001'

class PdfSnapshotContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.name='case_pdf_contract_'+uuid4().hex[:10]
        with psycopg.connect(dbname='postgres',**LOCAL) as admin: admin.execute('create database '+cls.name)
        cls.db=psycopg.connect(dbname=cls.name,**LOCAL)
        cls.db.execute((ROOT/'tests/postgres/notebook-fixture.sql').read_text())
        foundation=(ROOT/'supabase/migrations/20260520192000_foundation_schema.sql').read_text()
        cls.db.execute('create table motorist_calls(id uuid primary key)')
        for table in ['motorist_contacts','motorist_vehicles','motorist_locations','motorist_branches','motorist_fleet_assets','motorist_cases','motorist_case_tasks','motorist_case_events','motorist_sms_messages']:
            cls.db.execute(re.search(r'create table public\.'+table+r' \(.*?\n\);',foundation,re.S).group())
        cls.db.execute((ROOT/'supabase/migrations/20260601133000_extended_case_card.sql').read_text())
        cls.db.execute((ROOT/'supabase/migrations/20260521113000_selected_asset_assignment.sql').read_text())
        cls.db.execute((ROOT/'supabase/migrations/20260522121500_fleet_staff_fields.sql').read_text())
        cls.db.execute("alter table motorist_cases alter column source_type drop not null, alter column case_type drop not null; alter table motorist_case_tasks add column priority text default 'normal'")
        cls.db.execute('create unique index on motorist_cases(id,organization_id); create unique index on motorist_case_tasks(id,organization_id)')
        migration=(ROOT/'supabase/migrations/20260929120000_task_workspace.sql').read_text()
        cls.db.execute(re.search(r'create table public\.motorist_task_case_links \(.*?\n\);',migration,re.S).group())
        cls.db.execute((ROOT/'supabase/migrations/20260929140000_case_pdf_snapshot.sql').read_text())
        cls.db.execute("insert into motorist_contacts(id,organization_id,name,role) values(%s,%s,'0','client')",(CONTACT,ORG))
        cls.db.execute("insert into motorist_vehicles(id,organization_id,license_plate) values(%s,%s,'0')",(VEHICLE,ORG))
        cls.db.execute("insert into motorist_cases(id,organization_id,case_number,status,priority,summary,contact_id,vehicle_id) values(%s,%s,'PDF-TEST','open','normal','0',%s,%s)",(CASE,ORG,CONTACT,VEHICLE))
        cls.db.execute("insert into motorist_case_events(organization_id,case_id,event_type,title,body) values(%s,%s,'note_added','Note','0')",(ORG,CASE))
        cls.db.execute("insert into motorist_sms_messages(organization_id,case_id,to_number,direction,status,body,raw_payload) values(%s,%s,'+421900000001','outbound','sent','0','{\"private_key\":\"DO_NOT_EXPORT\"}')",(ORG,CASE))
    @classmethod
    def tearDownClass(cls):
        cls.db.close()
        with psycopg.connect(dbname='postgres',**LOCAL) as admin: admin.execute('drop database '+cls.name)
    def snapshot(self,actor=ACTOR,case=CASE):
        return self.db.execute('select motorist_case_pdf_snapshot(%s,%s,%s)',(ORG,actor,case)).fetchone()[0]
    def test_snapshot_is_consistent_during_multitable_writes(self):
        def writer():
            with psycopg.connect(dbname=self.name,**LOCAL) as db:
                for number in range(1,31):
                    with db.transaction():
                        for table,column in [('motorist_cases','summary'),('motorist_contacts','name'),('motorist_vehicles','license_plate'),('motorist_case_events','body'),('motorist_sms_messages','body')]:
                            db.execute(f'update {table} set {column}=%s',(str(number),))
        with ThreadPoolExecutor(max_workers=1) as pool:
            work=pool.submit(writer)
            for _ in range(60):
                snapshot=self.snapshot()
                values=[snapshot['case']['summary'],snapshot['contact']['name'],snapshot['vehicle']['license_plate'],snapshot['events'][0]['body'],snapshot['sms'][0]['body']]
                self.assertEqual(len(set(values)),1,values)
            work.result()
    def test_assigned_asset_is_scoped_and_snapshot_identified(self):
        asset=str(uuid4())
        self.db.execute("insert into motorist_fleet_assets(id,organization_id,kind,label,status,assigned_driver_name) values(%s,%s,'tow_truck','PDF tow','assigned','Ján')",(asset,ORG))
        try:
            self.db.execute('update motorist_cases set selected_asset_id=%s where id=%s',(asset,CASE))
            value=self.snapshot()
            self.assertEqual(value['assignedAsset']['label'],'PDF tow')
            self.assertEqual(value['assignedAsset']['assignedDriverName'],'Ján')
            self.assertIn('snapshotAt',value)
            self.db.execute("update motorist_fleet_assets set organization_id='10000000-0000-0000-0000-000000000002' where id=%s",(asset,))
            self.assertIsNone(self.snapshot()['assignedAsset'])
        finally:
            self.db.execute('update motorist_cases set selected_asset_id=null where id=%s',(CASE,))
            self.db.execute('delete from motorist_fleet_assets where id=%s',(asset,))
    def test_snapshot_omits_provider_payload_and_private_content(self):
        value=self.snapshot()
        self.assertNotIn('raw_payload',value['sms'][0])
        self.assertNotIn('DO_NOT_EXPORT',str(value))
        self.assertNotIn('notebook',value)
        self.assertNotIn('messages',value)
    def test_other_org_and_missing_case_are_denied(self):
        with self.assertRaises(psycopg.errors.InsufficientPrivilege): self.snapshot(actor='20000000-0000-0000-0000-000000000004')
        with self.assertRaises(psycopg.errors.NoDataFound): self.snapshot(case=str(uuid4()))
    def test_direct_authenticated_rpc_is_denied(self):
        self.db.execute('set role authenticated')
        try:
            with self.assertRaises(psycopg.errors.InsufficientPrivilege): self.snapshot()
        finally: self.db.execute('reset role')
if __name__=='__main__': unittest.main(verbosity=2)
