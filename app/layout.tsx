import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';
import { QuestionsLink } from '@/components/learn-questions';

export const metadata: Metadata = { title: 'Mangá em Vídeo', description: 'Transforme capítulos de mangá em vídeo com controle manual' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR" suppressHydrationWarning>
      <body className="min-h-screen antialiased" suppressHydrationWarning>
        <header className="border-b">
          <div className="mx-auto flex h-12 max-w-[1600px] items-center px-4">
            <Link href="/" className="font-semibold">
              Mangá <span className="text-primary">em Vídeo</span>
            </Link>
            <Link href="/gestao" className="ml-auto text-sm text-muted-foreground hover:text-foreground">
              Gestão
            </Link>
            <Link href="/perfis" className="ml-4 text-sm text-muted-foreground hover:text-foreground" title="O que o gestor aprendeu nos testes de corte">
              Perfis de corte
            </Link>
            <QuestionsLink />
            <Link href="/exemplos" className="ml-4 text-sm text-muted-foreground hover:text-foreground">
              Assets de exemplo
            </Link>
            <Link href="/usage" className="ml-4 text-sm text-muted-foreground hover:text-foreground">
              Consumo IA
            </Link>
          </div>
        </header>
        <main className="mx-auto max-w-[1600px] p-4">{children}</main>
      </body>
    </html>
  );
}
