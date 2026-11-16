import { NarrationPanel } from '@/components/narration-panel';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  return <NarrationPanel id={(await params).id} />;
}
