{ pkgs ? import <nixpkgs> {} }:

let
  python = pkgs.python313;
  pythonPkgs = python.pkgs;
in
pkgs.mkShell {
  packages = [
    (python.withPackages (ps: with ps; [
      anthropic
      fastapi
      uvicorn
      python-dotenv
      pydantic
      websockets
      feedparser
      setuptools
      wheel
    ]))
  ];

  shellHook = ''
    export PYTHONPATH="${toString ./.}:$PYTHONPATH"
    echo "claude-wrapper dev shell ready"
    echo "Run: python -m claude_wrapper.server"
  '';
}
