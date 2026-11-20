import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';
import { QuestionsLink } from '@/components/learn-questions';
import { ClaudeUsageBadge } from '@/components/claude-usage-badge';

export const metadata: Metadata = { title: 'Mangá em Vídeo', description: 'Transforme capítulos de mangá em vídeo com controle manual' };

// Com o servidor de desenvolvimento ocupado (render/roteiro rodando) um pacote da tela pode vir cortado ou com erro 500: a tela ficaria
// presa em "Carregando…". Este vigia roda antes de tudo e recarrega sozinho (no máximo 4 vezes em 2 minutos).
const RECOVER = `(function(){function r(){try{var k='auto-recover',n=JSON.parse(sessionStorage.getItem(k)||'[]').filter(function(t){return Date.now()-t<120000});if(n.length>=4)return;n.push(Date.now());sessionStorage.setItem(k,JSON.stringify(n))}catch(e){}setTimeout(function(){location.reload()},1500)}
addEventListener('error',function(e){var m=String(e.message||'');var t=e.target;if(t&&(t.tagName==='SCRIPT'||t.tagName==='LINK')&&t.src!==''||/ChunkLoadError|Loading chunk|Invalid or unexpected token|Unexpected token/.test(m))r()},true);
addEventListener('unhandledrejection',function(e){if(/ChunkLoadError|Loading chunk|Failed to fetch dynamically/.test(String(e.reason&&(e.reason.name+e.reason.message))))r()})})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR" suppressHydrationWarning>
      <body className="min-h-screen antialiased" suppressHydrationWarning>
        <script dangerouslySetInnerHTML={{ __html: RECOVER }} />
        <header className="border-b">
          <div className="mx-auto flex h-12 max-w-[1600px] items-center px-4">
            <Link href="/" className="font-semibold">
              Mangá <span className="text-primary">em Vídeo</span>
            </Link>
            <ClaudeUsageBadge />
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
