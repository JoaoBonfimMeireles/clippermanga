import { TabStatus } from '@/components/tab-status';

export default async function Layout({ children, params }: { children: React.ReactNode; params: Promise<{ id: string }> }) {
  return (
    <>
      <TabStatus id={(await params).id} />
      {children}
    </>
  );
}
