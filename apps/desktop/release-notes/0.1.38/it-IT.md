## Novità

- Incolla testo, link, percorsi di file e immagini nel campo di Hermes. Link e percorsi restano come chip di riferimento, i testi lunghi e le immagini dagli appunti diventano allegati, e gli incollaggi troppo grandi vengono rifiutati prima di inserire qualsiasi cosa.
- Il selettore dei modelli di Hermes ora supporta la ricerca e il rilevamento dei modelli locali viene eseguito in un processo separato: esplorare i modelli non scrive più nel profilo attivo e non blocca la chat.

## Correzioni

- Un breve errore di rete o di risveglio non sostituisce più la conversazione con una schermata di accesso. La trascrizione nella cache resta visibile dietro un avviso di riconnessione, e un nuovo tentativo verifica subito.
- Il selettore delle sessioni ricarica la cronologia a ogni apertura o cambio di vista, così le sessioni create da un altro client, da un gateway o da un’attività pianificata compaiono senza riavviare l’app.
- Il campo cresce con una bozza su più righe fino a 110 px, anche durante la composizione IME, e torna all’altezza originale quando Invia o Nuova chat cancellano la bozza.
- Un turno interrotto mostra ora un’etichetta chiara di turno interrotto, e le risposte interrotte restano vuote; l’interfaccia inglese non mostra più testo cinese di arresto.
- L’invio mentre una risposta è in corso segue la politica di input occupato: il messaggio viene reindirizzato, guidato o messo in coda invece di avviare un secondo turno, e Interrompi resta disponibile.
- Gli aggiornamenti di streaming e di ragionamento non trascinano più la trascrizione in fondo mentre leggi messaggi precedenti. Segue il contenuto più recente solo se sei già in fondo.
- Installazione, aggiornamento e disinstallazione del runtime di Hermes ora condividono un unico ciclo di vita: ogni installazione viene preparata in una directory separata, un’attivazione fallita viene annullata, vengono rimossi solo i processi avviati da OpenNavo e un gateway che non si avvia fallisce subito invece di lasciare la chat a metà avvio.
- La cronologia resta coerente tra i client e segue le rinominazioni e le eliminazioni dei profili; lo stato di pannelli e modelli resta isolato per finestra e le azioni del turno sono legate al proprio turno, così un turno in background non può fermare o terminare un’altra conversazione.
- Un provider personalizzato non ripiega più silenziosamente sui modelli integrati quando il suo catalogo non è raggiungibile.
