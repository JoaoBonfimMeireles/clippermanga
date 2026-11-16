import { FinalStudio } from '@/components/final-studio';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  return <FinalStudio id={(await params).id} />;
}
