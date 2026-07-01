import { NextResponse } from 'next/server';
import { createClient } from '@/utils/supabase/server';
import { cookies } from 'next/headers';

export async function POST(req: Request) {
  const supabase = createClient();
  const { data: { session }, error: authError } = await supabase.auth.getSession();

  if (authError || !session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Check if admin via Supabase (table user_roles)
  const { data: adminRole, error: roleError } = await supabase
    .from('user_roles')
    .select('*')
    .eq('role', 'admin')
    .or(`identifier.eq.${session.user.email},identifier.eq.${session.user.user_metadata?.username}`)
    .single();

  if (roleError || !adminRole) {
    return NextResponse.json({ error: 'Forbidden. Not an admin.' }, { status: 403 });
  }

  try {
    const body = await req.json();
    const { action, path, contentBase64 } = body;
    
    // Use Supabase Service Role for admin tasks
    const supabaseAdmin = require('@supabase/supabase-js').createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    if (action === 'check') {
      const { data: admins } = await supabaseAdmin.from('user_roles').select('identifier').eq('role', 'admin');
      return NextResponse.json({ success: true, isSuperAdmin: true, admins: admins?.map(a => a.identifier) || [] });
    }

    if (action === 'tree') {
      // List files from Supabase Storage instead of GitHub
      const { data: contentFiles, error: err1 } = await supabaseAdmin.storage.from('mr_capsules_files').list('content');
      const { data: coverFiles, error: err2 } = await supabaseAdmin.storage.from('mr_capsules_files').list('cover');
      
      const mapToTree = (files: any[], prefix: string) => files?.map(f => ({
        path: `${prefix}/${f.name}`,
        type: f.id ? 'blob' : 'tree',
        sha: f.id || null
      })) || [];

      const tree = [
        ...mapToTree(contentFiles, 'content'),
        ...mapToTree(coverFiles, 'cover')
      ];

      return NextResponse.json({ success: true, tree });
    }

    if (action === 'upload') {
      const buffer = Buffer.from(contentBase64, 'base64');
      const { data, error } = await supabaseAdmin.storage.from('mr_capsules_files').upload(path, buffer, {
        upsert: true
      });
      if (error) throw error;
      return NextResponse.json({ success: true, data });
    }

    if (action === 'delete') {
      const { error } = await supabaseAdmin.storage.from('mr_capsules_files').remove([path]);
      if (error) throw error;
      return NextResponse.json({ success: true });
    }

    if (action === 'delete_files') {
      const { files } = body;
      const paths = files.map((f: any) => f.path);
      const { error } = await supabaseAdmin.storage.from('mr_capsules_files').remove(paths);
      if (error) throw error;
      return NextResponse.json({ success: true });
    }

    if (action === 'get_users') {
      const { data: users, error } = await supabaseAdmin.auth.admin.listUsers();
      if (error) throw error;
      return NextResponse.json({ success: true, users: users.users || [] });
    }

    if (action === 'get_config') {
      // Config could be stored in a table or a specific file in storage
      const { data, error } = await supabaseAdmin.storage.from('mr_capsules_files').download('config.json');
      if (error) return NextResponse.json({ success: true, config: {} });
      const text = await data.text();
      return NextResponse.json({ success: true, config: JSON.parse(text) });
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
