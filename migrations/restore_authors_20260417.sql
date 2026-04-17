-- Restore structured authors for 10 collections damaged by syncEdition bug (pre Apr 17)
-- id=17 DC Pocket
UPDATE collections SET authors = '[{"name":"Geoff Johns","role":"Guion"},{"name":"Neil Gaiman","role":"Guion"},{"name":"Tom King","role":"Guion"},{"name":"James Tynion IV","role":"Guion"},{"name":"Scott Snyder","role":"Guion"},{"name":"Gary Frank","role":"Dibujo, Tinta"},{"name":"Alex Sinclair","role":"Color"},{"name":"Brian Azzarello","role":"Guion"},{"name":"Grant Morrison","role":"Guion, Dibujo"},{"name":"Ivan Reis","role":"Dibujo, Tinta"}]' WHERE id = 17;
-- id=21 Absolute Batman
UPDATE collections SET authors = '[{"name":"Scott Snyder","role":"Guion"},{"name":"Nick Dragotta","role":"Dibujo, Tinta"},{"name":"Frank Martin","role":"Color"},{"name":"Marcos Martín","role":"Dibujo, Tinta"},{"name":"Munsta Vicente","role":"Color"},{"name":"Jock","role":""},{"name":"Clay Mann","role":"Dibujo, Tinta"},{"name":"James Harren","role":""},{"name":"Ivan Plascencia","role":"Color"},{"name":"Gabriel Hernández Walta","role":"Dibujo, Tinta"},{"name":"Daniel Warren Johnson","role":"Guion, Dibujo"},{"name":"Meredith McClaren","role":""}]' WHERE id = 21;
-- id=27 Marvel Must-Have
UPDATE collections SET authors = '[{"name":"Mark Morales","role":"Tinta"},{"name":"Brian Michael Bendis","role":"Guion"},{"name":"Paul Mounts","role":"Color"},{"name":"Justin Ponsor","role":"Color"},{"name":"Laura Martin","role":"Color"},{"name":"John Romita Jr.","role":"Dibujo"},{"name":"Olivier Coipel","role":"Dibujo, Tinta"},{"name":"Dexter Vines","role":"Tinta"},{"name":"Frank D''Armata","role":"Color"},{"name":"Steve McNiven","role":"Dibujo, Tinta"}]' WHERE id = 27;
-- id=82 DC One-Shot
UPDATE collections SET authors = '[{"name":"Marissa Louise","role":"Color"},{"name":"Dan Watters","role":"Guion"},{"name":"Triona Farrell","role":"Color"},{"name":"Christopher Cantwell","role":"Guion"},{"name":"Hayden Sherman","role":"Dibujo, Tinta"},{"name":"Leah Williams","role":"Guion"},{"name":"Haining","role":"Dibujo, Tinta"},{"name":"Shannon Hale","role":"Guion"},{"name":"Jamal Campbell","role":"Guion, Dibujo"},{"name":"Cian Tormey","role":""}]' WHERE id = 82;
-- id=83 All in Aquaman
UPDATE collections SET authors = '[{"name":"John Timms","role":"Dibujo, Color"},{"name":"Jeremy Adams","role":"Guion"},{"name":"Michael Shelfer","role":"Dibujo, Tinta"}]' WHERE id = 83;
-- id=104 A Silent Voice
UPDATE collections SET authors = '[{"name":"Yoshitoki Oima","role":"Guion, Dibujo, Tinta"}]' WHERE id = 104;
-- id=128 Vagabond
UPDATE collections SET authors = '[{"name":"Takehiko Inoue","role":"Guion, Dibujo, Tinta"}]' WHERE id = 128;
-- id=150 Dragon Quest: The Adventure of Dai
UPDATE collections SET authors = '[{"name":"Riku Sanjo","role":"Guion"},{"name":"Koji Inada","role":"Dibujo, Tinta"}]' WHERE id = 150;
-- id=155 DC Elseworlds
UPDATE collections SET authors = '[{"name":"Matt Hollingsworth","role":"Color"},{"name":"Andy Diggle","role":"Guion"},{"name":"Arif Prianto","role":"Color"},{"name":"Leandro Fernández","role":"Dibujo, Tinta"},{"name":"Tom Taylor","role":"Guion"},{"name":"Jay Kristoff","role":"Guion"},{"name":"Jen Barel Bengal","role":"Dibujo, Tinta, Color"},{"name":"Giovanna Niro","role":"Color"},{"name":"Caspar Wijngaard","role":"Dibujo, Tinta, Color"},{"name":"Yasmine Putri","role":"Dibujo, Tinta, Color"}]' WHERE id = 155;
-- id=250 Universo Sandman: El Sueño
UPDATE collections SET authors = '[{"name":"Simon Spurrier","role":"Guion"},{"name":"Bilquis Evely","role":"Dibujo"},{"name":"Mat Lopes","role":"Color"},{"name":"Dominike Stanton","role":""},{"name":"Kat Howard","role":"Guion"},{"name":"Nalo Hopkinson","role":"Guion"},{"name":"Tiffany Turrell","role":""},{"name":"Neil Gaiman","role":"Guion"},{"name":"Max Fiumara","role":""},{"name":"Tom Fowler","role":""},{"name":"Sebastian Fiumara","role":""},{"name":"Matias Bergara","role":""}]' WHERE id = 250;
