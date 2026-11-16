import { VideoEditor } from '@/components/video-editor';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  return <VideoEditor id={(await params).id} />;
}
